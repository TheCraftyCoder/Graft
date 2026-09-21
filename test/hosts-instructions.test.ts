import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instructionBody, cursorRule, kiroSteering, windsurfRule } from '../src/hosts/instructions.js';

test('canonical body teaches selective structural use and source verification', () => {
  const b = instructionBody();
  assert.match(b, /^## Graft — structural repo map/m);
  assert.match(b, /graft ask/);
  assert.match(b, /graft callers/);
  assert.match(b, /graft skeleton/);
  assert.match(b, /graft grep/);
  assert.match(b, /graft map/);
  assert.match(b, /known file, symbol, literal, RPC id, type, store/i);
  assert.match(b, /source, `rg`, or LSP\/reference search/);
  assert.match(b, /navigation evidence, not authoritative truth/i);
  assert.match(b, /ranked top-N/i);
  assert.match(b, /high-risk work/i);
  assert.doesNotMatch(b, /For ANY task/i);
  assert.doesNotMatch(b, /top node IS the answer/i);
  assert.doesNotMatch(b, /tokens saved/i);
  assert.ok(!/\bhook|statusline\b/i.test(b), 'no host-specific machinery in the shared body');
});

test('cursor rule has alwaysApply frontmatter, selective description, and the body', () => {
  const r = cursorRule();
  assert.match(r, /^---\ndescription: Use Graft selectively.+\nalwaysApply: true\n---\n/);
  assert.ok(r.includes(instructionBody()));
});

test('kiro steering has inclusion: always frontmatter and the body', () => {
  const r = kiroSteering();
  assert.match(r, /^---\ninclusion: always\n---\n/);
  assert.ok(r.includes(instructionBody()));
});

test('windsurf rule is the plain body', () => {
  assert.ok(windsurfRule().includes(instructionBody()));
});
