/**
 * `agents-md` is the instruction-only AGENTS.md host: exactly one write, the
 * fenced section — none of the Codex/OpenCode/global side effects `agents` has.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpRepo } from './helpers.js';
import { planInit, selectedWrites } from '../src/hosts/plan.js';
import { runHostsInit } from '../src/hosts/init.js';
import { planRetract } from '../src/hosts/retract.js';
import { mcpTargets } from '../src/hosts/mcp-config.js';
import { upsertSection } from '../src/hosts/sections.js';
import { instructionBody } from '../src/hosts/instructions.js';

function fixture(): { repo: string; home: string } {
  const repo = tmpRepo('agentsmd-repo');
  const home = tmpRepo('agentsmd-home');
  // Everything `agents` would otherwise pick up is present.
  mkdirSync(join(home, '.codex'), { recursive: true });
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true });
  return { repo, home };
}

test('plan for agents-md is exactly the AGENTS.md section', () => {
  const { repo, home } = fixture();
  const writes = selectedWrites(planInit(repo, { home }), ['agents-md']);
  assert.deepEqual(writes.map((w) => w.path), [join(repo, 'AGENTS.md')]);
  assert.equal(mcpTargets(repo, ['agents-md'], { home }).length, 0);
});

test('agents-md init yields exactly one write and no Codex/OpenCode output', () => {
  const { repo, home } = fixture();
  const r = runHostsInit(repo, { agents: ['agents-md'], home });
  assert.deepEqual(r.written.map((w) => w.path), [join(repo, 'AGENTS.md')]);
  assert.deepEqual(r.mcp, []);
  assert.deepEqual(r.hooks, []);
  assert.ok(!existsSync(join(home, '.codex', 'config.toml')));
  assert.ok(!existsSync(join(home, '.codex', 'hooks.json')));
  assert.ok(!existsSync(join(repo, 'opencode.json')));
  assert.ok(readFileSync(join(repo, 'AGENTS.md'), 'utf8').includes(instructionBody().trim().split('\n')[0]));
});

test('backwards compat: agents still writes AGENTS.md + Codex + OpenCode', () => {
  const { repo, home } = fixture();
  const r = runHostsInit(repo, { agents: ['agents'], home });
  assert.ok(existsSync(join(repo, 'AGENTS.md')));
  assert.ok(r.mcp.some((m) => m.id === 'codex'));
  assert.ok(r.mcp.some((m) => m.id === 'opencode'));
  assert.ok(r.hooks.length > 0);
});

test('retract keeps AGENTS.md when agents-md is the kept host', () => {
  const { repo, home } = fixture();
  upsertSection(join(repo, 'AGENTS.md'), instructionBody());
  const plan = planRetract(repo, { home, exclude: ['agents-md'] });
  assert.ok(!plan.some((r) => r.path === join(repo, 'AGENTS.md')));
  const without = planRetract(repo, { home });
  assert.ok(without.some((r) => r.path === join(repo, 'AGENTS.md') && r.action !== 'absent'));
});
