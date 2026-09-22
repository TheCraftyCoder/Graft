import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instructionBody, instructionHint, cursorRule, kiroSteering, windsurfRule } from '../src/hosts/instructions.js';

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

test('always-on hint is tiny and points to progressive disclosure', () => {
  const h = instructionHint();
  assert.match(h, /on-demand `graft` skill/);
  assert.match(h, /navigation evidence/);
  assert.doesNotMatch(h, /graft ask|graft callers|graft skeleton|graft grep|graft map/);
  assert.ok(h.length < 400, `always-on hint should stay tiny, got ${h.length} chars`);
});

test('cursor compatibility rule is no longer always-on', () => {
  const r = cursorRule();
  assert.match(r, /alwaysApply: false/);
  assert.ok(r.includes(instructionHint()));
  assert.ok(!r.includes(instructionBody()));
});

test('kiro compatibility steering is manual; the skill handles automatic discovery', () => {
  const r = kiroSteering();
  assert.match(r, /^---\ninclusion: manual\n---\n/);
  assert.ok(r.includes(instructionHint()));
});

test('windsurf uses model-decision loading: description always, full body only when relevant', () => {
  const r = windsurfRule();
  assert.match(r, /^---\ntrigger: model_decision\ndescription: .+\n---\n/);
  assert.ok(r.includes(instructionBody()));
});
