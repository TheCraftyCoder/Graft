/**
 * `graft init --preserve-unselected`: selected hosts may change; unselected hosts'
 * wiring is never created, updated, or deleted. Without the flag, init still
 * converges (retracts unselected hosts) — pinned here as the regression baseline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { tmpRepo, runCli } from './helpers.js';
import { readStamp, reconcileWiring } from '../src/upkeep.js';

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const skip = (p: string): boolean => p.includes(sep + '.graft' + sep); // graft's own update-check state
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!skip(p)) out.set(p, createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

const USER_AGENTS_HEAD = '# My project rules\n\nUse tabs.\n\n';
const USER_AGENTS_TAIL = '\n\n## Footer\n\nKeep it short.\n';

/** Pre-wire every host, then wrap the shared AGENTS.md section in user content. */
function wiredFixture(): { repo: string; home: string } {
  const repo = tmpRepo('preserve-repo');
  const home = tmpRepo('preserve-home');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  mkdirSync(join(home, '.cursor'), { recursive: true });
  mkdirSync(join(repo, '.github'), { recursive: true });
  const pre = runCli(
    ['init', repo, '--agents', 'agents', 'gemini', 'cursor', 'copilot', 'grok', 'antigravity', '--no-build', '--no-statusline'],
    { home },
  );
  assert.equal(pre.status, 0, pre.describe());
  const agentsMd = join(repo, 'AGENTS.md');
  writeFileSync(agentsMd, USER_AGENTS_HEAD + readFileSync(agentsMd, 'utf8') + USER_AGENTS_TAIL);
  return { repo, home };
}

interface Diff { changed: string[]; created: string[]; deleted: string[] }
function diff(before: Map<string, string>, after: Map<string, string>): Diff {
  return {
    changed: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)),
    created: [...after.keys()].filter((k) => !before.has(k)),
    deleted: [...before.keys()].filter((k) => !after.has(k)),
  };
}

function rel(root: string, p: string): string {
  return relative(root, p).split(sep).join('/');
}

const SELECTED = ['claude', 'grok', 'agents-md'];
const ARGS = (repo: string, extra: string[] = []): string[] => [
  'init', repo, '--agents', ...SELECTED, '--no-global', '--no-build', '--no-statusline', ...extra,
];

test('--preserve-unselected leaves every unselected host byte-identical', () => {
  const { repo, home } = wiredFixture();
  assert.ok(existsSync(join(repo, 'opencode.json')));
  assert.ok(existsSync(join(home, '.codex', 'hooks.json')));
  const beforeRepo = snapshot(repo);
  const beforeHome = snapshot(home);

  const r = runCli(ARGS(repo, ['--preserve-unselected']), { home });
  assert.equal(r.status, 0, r.describe());
  assert.ok(!/agent not selected/.test(r.stderr), r.describe());

  // Home: nothing at all may change (--no-global, and no selected host is global).
  assert.deepEqual(diff(beforeHome, snapshot(home)), { changed: [], created: [], deleted: [] });

  // Repo: only Claude / Grok / graft cache files may differ; everything else is identical.
  const afterRepo = snapshot(repo);
  const d = diff(beforeRepo, afterRepo);
  assert.deepEqual(d.deleted.map((p) => rel(repo, p)), []);
  const allowed = /^(\.claude\/|\.mcp\.json$|\.grok\/|graft\/|\.gitignore$|\.ignore$)/;
  for (const p of [...d.changed, ...d.created]) {
    assert.match(rel(repo, p), allowed, `unexpected repo write: ${rel(repo, p)}`);
  }
  for (const f of ['opencode.json', '.cursor/rules/graft.mdc', '.cursor/hooks.json', '.cursor/mcp.json',
    'GEMINI.md', '.gemini/settings.json', '.github/copilot-instructions.md']) {
    assert.ok(beforeRepo.has(join(repo, f)), `fixture missing ${f}`);
    assert.equal(beforeRepo.get(join(repo, f)), afterRepo.get(join(repo, f)), f);
  }
  // Shared AGENTS.md: user content around the graft section is intact.
  const md = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  assert.ok(md.startsWith(USER_AGENTS_HEAD) && md.endsWith(USER_AGENTS_TAIL));

  // The stamp records the flag so an automatic refresh cannot re-adopt other hosts.
  const stamp = readStamp(repo)!;
  assert.equal(stamp.opts?.preserve, true);
  assert.deepEqual(stamp.hosts, [...SELECTED].sort());
});

test('refresh under a preserve stamp rewrites only stamped hosts', () => {
  const { repo } = wiredFixture();
  const seen: string[][] = [];
  const stampFile = join(repo, 'graft', '.cache', 'wiring-stamp.json');
  mkdirSync(dirname(stampFile), { recursive: true });
  writeFileSync(stampFile, JSON.stringify({ version: '0.0.1', hosts: ['agents-md', 'claude'], opts: { preserve: true }, at: 'x' }));
  reconcileWiring(repo, '9.9.9', { rewrite: (_r, hosts) => { seen.push(hosts); } });
  assert.deepEqual(seen, [['agents-md', 'claude']]);
  assert.equal(readStamp(repo)?.opts?.preserve, true);
});

test('without the flag, init still converges: unselected hosts are retracted', () => {
  const { repo, home } = wiredFixture();
  const r = runCli(ARGS(repo), { home });
  assert.equal(r.status, 0, r.describe());
  assert.match(r.stderr, /agent not selected/);
  assert.ok(!existsSync(join(repo, '.cursor', 'rules', 'graft.mdc')));
  assert.ok(!existsSync(join(repo, 'GEMINI.md')) || !/graft/i.test(readFileSync(join(repo, 'GEMINI.md'), 'utf8')));
  assert.equal(readStamp(repo)?.opts?.preserve, false);
});

test('agents-md never touches ~/.codex or opencode.json', () => {
  const repo = tmpRepo('agentsmd-cli-repo');
  const home = tmpRepo('agentsmd-cli-home');
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  const beforeHome = snapshot(home);
  const r = runCli(['init', repo, '--agents', 'agents-md', '--preserve-unselected', '--no-build'], { home });
  assert.equal(r.status, 0, r.describe());
  assert.deepEqual(diff(beforeHome, snapshot(home)), { changed: [], created: [], deleted: [] });
  assert.ok(!existsSync(join(repo, 'opencode.json')));
  assert.ok(existsSync(join(repo, 'AGENTS.md')));
});
