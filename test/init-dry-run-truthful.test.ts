/**
 * `graft init --dry-run` must tell the truth: it changes nothing, it lists what
 * the real run would write AND retract under the same flags, and the real run
 * then changes nothing outside that list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { tmpRepo, runCli } from './helpers.js';
import { planOperations, writeAllowed, type OperationOpts } from '../src/hosts/plan.js';

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (!p.includes(sep + '.graft' + sep)) out.set(p, createHash('sha256').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(root);
  return out;
}

const USER_AGENTS = '# My project rules\n\nUse tabs.\n\n';

/** Repo + home pre-wired for every host, AGENTS.md wrapped in user content. */
function wiredFixture(): { repo: string; home: string } {
  const repo = tmpRepo('dryrun-repo');
  const home = tmpRepo('dryrun-home');
  for (const d of ['.codex', join('.config', 'opencode'), join('.gemini', 'config'), '.cursor']) {
    mkdirSync(join(home, d), { recursive: true });
  }
  mkdirSync(join(repo, '.github'), { recursive: true });
  const pre = runCli(
    ['init', repo, '--agents', 'claude', 'agents', 'gemini', 'cursor', 'copilot', 'grok', '--no-build'],
    { home },
  );
  assert.equal(pre.status, 0, pre.describe());
  const md = join(repo, 'AGENTS.md');
  writeFileSync(md, USER_AGENTS + readFileSync(md, 'utf8'));
  return { repo, home };
}

interface Scenario { name: string; ids: string[]; flags: string[]; opts: Omit<OperationOpts, 'home'> }
const SEL = ['claude', 'grok', 'agents-md'];
const scenarios: Scenario[] = [
  { name: 'default', ids: SEL, flags: [], opts: {} },
  { name: 'preserve-unselected', ids: SEL, flags: ['--preserve-unselected'], opts: { preserve: true } },
  { name: 'no-global', ids: SEL, flags: ['--no-global'], opts: { global: false } },
  { name: 'no-mcp', ids: SEL, flags: ['--no-mcp'], opts: { mcp: false } },
  { name: 'no-hooks', ids: SEL, flags: ['--no-hooks'], opts: { hooks: false } },
  { name: 'no-statusline', ids: SEL, flags: ['--no-statusline'], opts: { statusline: false } },
  { name: 'converge claude only', ids: ['claude'], flags: [], opts: {} },
];

const isBookkeeping = (repo: string, p: string): boolean =>
  /^(graft\/|\.gitignore$|\.ignore$)/.test(relative(repo, p).split(sep).join('/'));

for (const sc of scenarios) {
  test(`dry-run is truthful: ${sc.name}`, () => {
    const { repo, home } = wiredFixture();
    const args = ['init', repo, '--agents', ...sc.ids, '--no-build', ...sc.flags];

    // (a) pure function + CLI dry-run change nothing.
    const ops = planOperations(repo, sc.ids, { home, ...sc.opts });
    const before = new Map([...snapshot(repo), ...snapshot(home)]);
    const dry = runCli([...args, '--dry-run'], { home });
    assert.equal(dry.status, 0, dry.describe());
    assert.deepEqual(new Map([...snapshot(repo), ...snapshot(home)]), before, 'dry-run must not write');
    assert.match(dry.stderr, /nothing was written \(--dry-run\)/);

    const [wouldWrite, wouldRemove = ''] = dry.stderr.replaceAll('\\', '/').split('would remove / edit (retract)');
    const shown = (p: string): string => (p.startsWith(home) ? '~' + p.slice(home.length).split(sep).join('/') : relative(repo, p).split(sep).join('/'));
    for (const w of ops.writes) assert.ok(wouldWrite.includes(shown(w.path)), `dry-run lists write ${shown(w.path)}\n${dry.stderr}`);
    for (const r of ops.retractions) assert.ok(wouldRemove.includes(shown(r.path)), `dry-run lists retraction ${shown(r.path)}\n${dry.stderr}`);
    if (sc.opts.preserve) {
      assert.deepEqual(ops.retractions, []);
      assert.match(dry.stderr, /preserve-unselected: no unselected host will be created, updated or removed/);
    } else {
      assert.ok(ops.retractions.length > 0, 'fixture guarantees something to retract');
    }
    // A write the flags drop must not be listed under "would write".
    if (sc.opts.global === false) assert.ok(!ops.writes.some((w) => w.scope === 'global'));
    if (sc.opts.mcp === false) assert.ok(!ops.writes.some((w) => w.kind === 'mcp' && w.hostId !== 'claude'));
    if (sc.opts.hooks === false) assert.ok(!ops.writes.some((w) => w.kind === 'hook' && w.hostId !== 'claude'));

    // (b) the real run stays inside planned writes U retractions.
    const real = runCli(args, { home });
    assert.equal(real.status, 0, real.describe());
    const after = new Map([...snapshot(repo), ...snapshot(home)]);
    const planned = new Set([...ops.writes.map((w) => w.path), ...ops.retractions.map((r) => r.path)]);
    const touched = [
      ...[...after.keys()].filter((k) => before.get(k) !== after.get(k)),
      ...[...before.keys()].filter((k) => !after.has(k)),
    ].filter((p) => !isBookkeeping(repo, p));
    for (const p of touched) assert.ok(planned.has(p), `real run touched unplanned path ${p}`);

    // Every planned retraction that had something to remove really was removed/edited.
    for (const r of ops.retractions) {
      if (r.action === 'deleted' && !ops.writes.some((w) => w.path === r.path)) {
        assert.ok(!existsSync(r.path), `${r.path} should be deleted`);
      } else if (!ops.writes.some((w) => w.path === r.path)) {
        assert.notEqual(after.get(r.path), before.get(r.path), `${r.path} should be edited`);
      }
    }
    // User content in the shared AGENTS.md survives every scenario.
    assert.ok(readFileSync(join(repo, 'AGENTS.md'), 'utf8').startsWith(USER_AGENTS.trim()));

    if (sc.opts.preserve) {
      for (const f of ['opencode.json', '.cursor/rules/graft.mdc', '.cursor/hooks.json', 'GEMINI.md', '.github/copilot-instructions.md']) {
        assert.equal(after.get(join(repo, f)), before.get(join(repo, f)), `${f} unchanged under preserve`);
      }
      assert.equal(after.get(join(home, '.codex', 'hooks.json')), before.get(join(home, '.codex', 'hooks.json')));
    }
  });
}

test('writeAllowed exempts the Claude layer from --no-mcp/--no-hooks but not --no-global', () => {
  const claudeMcp = { hostId: 'claude', kind: 'mcp', scope: 'repo' } as const;
  const claudeGlobal = { hostId: 'claude', kind: 'hook', scope: 'global' } as const;
  assert.equal(writeAllowed(claudeMcp, { mcp: false }), true);
  assert.equal(writeAllowed(claudeGlobal, { hooks: false }), true);
  assert.equal(writeAllowed(claudeGlobal, { global: false }), false);
  assert.equal(writeAllowed({ hostId: 'cursor', kind: 'hook', scope: 'repo' }, { hooks: false }), false);
  assert.equal(writeAllowed({ hostId: 'cursor', kind: 'hook', scope: 'repo' }, { global: false }), true);
});
