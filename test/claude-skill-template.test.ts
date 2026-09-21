import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillTemplate } from '../src/claude/skill-template.js';

test('skill template is concise, selective, and evidence-aware', () => {
  const src = skillTemplate();
  assert.ok(src.startsWith('---\n'), 'starts with YAML frontmatter');
  assert.match(src, /^name: graft$/m);
  assert.match(src, /^description: Use Graft selectively/m);
  const body = src.split(/\n---\n/)[1] ?? '';
  assert.ok(body.trim().length > 0);
  assert.match(body, /source, `rg`, or LSP\/reference search directly/);
  assert.match(body, /graft callers/);
  assert.match(body, /--direction out/);
  assert.match(body, /--depth N/);
  assert.match(body, /graft skeleton/);
  assert.match(body, /graft ask/);
  assert.match(body, /graft map/);
  assert.match(body, /graft grep/);
  assert.match(body, /navigation evidence, not authoritative truth/i);
  assert.match(body, /read authoritative source before editing/i);
  assert.doesNotMatch(src, /For ANY task/i);
  assert.doesNotMatch(body, /Report what graft saved/i);
  assert.doesNotMatch(body, /🌱/);
  assert.ok(src.length < 4000, `skill should stay lean, got ${src.length} chars`);
});
