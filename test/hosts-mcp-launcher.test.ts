import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGraftLauncher } from '../src/hosts/mcp-config.js';

const BIN = { command: 'graft', args: ['mcp'] };
const NPX = { command: 'npx', args: ['-y', '@nanonets/graft', 'mcp'] };

type Call = { cmd: string; args: string[]; opts: Record<string, unknown> };
function fakeSpawn(status: number | null, calls: Call[]) {
  return (cmd: string, args: string[], opts: Record<string, unknown>) => {
    calls.push({ cmd, args, opts });
    return { status };
  };
}

function winDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'graft-launcher-'));
  for (const f of files) writeFileSync(join(dir, f), '');
  return dir;
}

test('windows: finds graft.cmd via PATH/PATHEXT and verifies through cmd.exe', () => {
  const dir = winDir(['graft.cmd']);
  const calls: Call[] = [];
  const r = detectGraftLauncher({
    platform: 'win32',
    env: { PATH: `C:\\nowhere;${dir}`, PATHEXT: '.EXE;.CMD', ComSpec: 'cmd-test.exe' },
    spawn: fakeSpawn(0, calls),
  });
  assert.deepEqual(r, BIN);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'cmd-test.exe');
  assert.deepEqual(calls[0].args, ['/d', '/s', '/c', `"${join(dir, 'graft.cmd')}" --version`]);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.windowsVerbatimArguments, true);
});

test('windows: not found on PATH falls back to npx without spawning', () => {
  const dir = winDir(['other.cmd']);
  const calls: Call[] = [];
  const r = detectGraftLauncher({
    platform: 'win32',
    env: { PATH: dir, PATHEXT: '.EXE;.CMD' },
    spawn: fakeSpawn(0, calls),
  });
  assert.deepEqual(r, NPX);
  assert.equal(calls.length, 0);
});

test('windows: failing --version falls back to npx', () => {
  const dir = winDir(['graft.cmd']);
  const r = detectGraftLauncher({
    platform: 'win32',
    env: { PATH: dir, PATHEXT: '.CMD' },
    spawn: fakeSpawn(1, []),
  });
  assert.deepEqual(r, NPX);
});

test('windows: unsafe characters in the resolved path are rejected', () => {
  const root = mkdtempSync(join(tmpdir(), 'graft-launcher-'));
  const dir = join(root, 'a&b');
  mkdirSync(dir);
  writeFileSync(join(dir, 'graft.cmd'), '');
  const calls: Call[] = [];
  const r = detectGraftLauncher({
    platform: 'win32',
    env: { PATH: dir, PATHEXT: '.CMD' },
    spawn: fakeSpawn(0, calls),
  });
  assert.deepEqual(r, NPX);
  assert.equal(calls.length, 0);
});

test('posix: uses a direct spawn of graft', () => {
  const calls: Call[] = [];
  const r = detectGraftLauncher({ platform: 'linux', env: {}, spawn: fakeSpawn(0, calls) });
  assert.deepEqual(r, BIN);
  assert.equal(calls[0].cmd, 'graft');
  assert.deepEqual(calls[0].args, ['--version']);
  assert.deepEqual(detectGraftLauncher({ platform: 'linux', env: {}, spawn: fakeSpawn(1, []) }), NPX);
});

test('GRAFT_MCP_LAUNCHER overrides probing; invalid values are ignored', () => {
  const calls: Call[] = [];
  const spawn = fakeSpawn(1, calls);
  assert.deepEqual(detectGraftLauncher({ platform: 'linux', env: { GRAFT_MCP_LAUNCHER: 'graft' }, spawn }), BIN);
  assert.deepEqual(detectGraftLauncher({ platform: 'linux', env: { GRAFT_MCP_LAUNCHER: 'npx' }, spawn: fakeSpawn(0, []) }), NPX);
  assert.equal(calls.length, 0, 'override is checked before probing');
  assert.deepEqual(detectGraftLauncher({ platform: 'linux', env: { GRAFT_MCP_LAUNCHER: 'bogus' }, spawn: fakeSpawn(0, []) }), BIN);
  assert.deepEqual(detectGraftLauncher({ platform: 'linux', env: { GRAFT_MCP_LAUNCHER: 'bogus' }, spawn: fakeSpawn(1, []) }), NPX);
});

test('GRAFT_MCP_NPX wins over GRAFT_MCP_LAUNCHER=graft', () => {
  const r = detectGraftLauncher({ platform: 'linux', env: { GRAFT_MCP_NPX: '1', GRAFT_MCP_LAUNCHER: 'graft' }, spawn: fakeSpawn(0, []) });
  assert.deepEqual(r, NPX);
});
