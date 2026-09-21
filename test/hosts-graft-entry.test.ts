import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGraftEntry } from '../src/hosts/config-write.js';
import { mergeGraftSettings } from '../src/claude/settings-merge.js';

const hook = (command: unknown) => ({ hooks: [{ type: 'command', command }] });

test('recognises every shape Graft has written', () => {
  const owned: unknown[] = [
    hook('node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/graft-hooks.cjs" post-edit'),
    hook('node "/home/u/.claude/helpers/graft-hooks.cjs" stop'),
    hook('node "C:\\Users\\u\\.claude\\helpers/graft-hooks.cjs" prompt'),
    hook('node "C:\\Users\\u\\.claude\\helpers\\graft-hooks.cjs" prompt'),
    { type: 'command', command: 'node "/home/u/.codex/hooks/graft/graft-hooks.cjs" post-edit-sync', timeout: 10000 },
    hook('node "/home/u/.codex/hooks/graft/graft-hooks.cjs" post-edit-sync'),
    { matcher: 'Write', command: 'node "/repo/.cursor/hooks/graft-hooks.cjs" cursor-post-tool' },
    { command: 'node "C:\\r\\.cursor\\hooks\\graft-hooks.cjs" cursor-mcp' },
    { command: 'node /repo/.claude/helpers/graft-hooks.cjs stop' },
  ];
  for (const e of owned) assert.equal(isGraftEntry(e), true, JSON.stringify(e));
});

test('foreign hooks that merely mention the filename are not owned', () => {
  const foreign: unknown[] = [
    { command: 'echo see graft-hooks.cjs' },
    { command: 'cat notes-graft-hooks.cjs.txt' },
    { command: 'node my-graft-hooks.cjs' },
    { command: 'node /opt/mytool/graft-hooks.cjs' },
    { command: 'node /x/.claude/helpers/my-graft-hooks.cjs' },
    { command: 'node /x/not.claude/helpers/graft-hooks.cjs' },
    { command: 'echo node /x/.claude/helpers/graft-hooks.cjs' },
    hook('cat /x/.claude/helpers/graft-hooks.cjs'),
    hook('other.sh --config graft-hooks.cjs'),
  ];
  for (const e of foreign) assert.equal(isGraftEntry(e), false, JSON.stringify(e));
});

test('malformed values are false and never throw', () => {
  const circ: any = { hooks: [] };
  circ.hooks.push(circ);
  circ.self = circ;
  const bad: unknown[] = [undefined, null, 5, 'graft-hooks.cjs', [], {}, { hooks: 'x' }, { hooks: [null, 3, {}] },
    { command: 42 }, hook(['node', 'x']), circ,
    { get command(): string { throw new Error('boom'); } }];
  for (const e of bad) assert.doesNotThrow(() => isGraftEntry(e));
  for (const e of bad) assert.equal(isGraftEntry(e), false);
});

test('mergeGraftSettings replaces graft hooks in place and keeps a foreign mention', () => {
  const foreign = hook('echo see graft-hooks.cjs');
  const stale = hook('node "/old/.claude/helpers/graft-hooks.cjs" stop');
  const { merged } = mergeGraftSettings({ hooks: { Stop: [foreign, stale] } } as any) as any;
  const stop = merged.hooks.Stop;
  assert.ok(stop.some((e: any) => e.hooks?.[0]?.command === 'echo see graft-hooks.cjs'));
  assert.equal(stop.filter((e: any) => isGraftEntry(e)).length, 1);
  assert.ok(!JSON.stringify(stop).includes('/old/'));
});
