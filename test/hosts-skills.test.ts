import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostSkillTargets, installHostSkills } from '../src/hosts/host-skills.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-hostskills-')); }

test('shared .agents skill covers Codex/OpenCode, Cursor, Gemini and Copilot once', () => {
  const repo = fresh(); const home = fresh();
  const t = hostSkillTargets(repo, ['agents', 'cursor', 'gemini', 'copilot'], { home });
  assert.equal(t.filter((x) => x.path === join(repo, '.agents', 'skills', 'graft', 'SKILL.md')).length, 1);
});

test('Kiro gets a native project skill; Hermes gets its global skill', () => {
  const repo = fresh(); const home = fresh();
  const t = hostSkillTargets(repo, ['kiro', 'hermes'], { home });
  assert.ok(t.some((x) => x.path === join(repo, '.kiro', 'skills', 'graft', 'SKILL.md') && x.scope === 'repo'));
  assert.ok(t.some((x) => x.path === join(home, '.hermes', 'skills', 'graft', 'SKILL.md') && x.scope === 'global'));
});

test('--no-global suppresses only Hermes; project skills still install', () => {
  const repo = fresh(); const home = fresh();
  const w = installHostSkills(repo, ['agents', 'kiro', 'hermes'], { home, global: false });
  assert.ok(existsSync(join(repo, '.agents', 'skills', 'graft', 'SKILL.md')));
  assert.ok(existsSync(join(repo, '.kiro', 'skills', 'graft', 'SKILL.md')));
  assert.ok(!existsSync(join(home, '.hermes', 'skills', 'graft', 'SKILL.md')));
  assert.ok(w.every((x) => readFileSync(x.path, 'utf8').includes('navigation evidence')));
});
