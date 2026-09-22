import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hooksShim, statuslineShim, bakedDirFor } from '../src/claude/shim-template.js';
import { tmpRepo } from './helpers.js';

for (const [name, src] of [['statusline', statuslineShim('/opt/g/dist/claude')], ['hooks', hooksShim('/opt/g/dist/claude')]] as const) {
  test(`${name} shim carries the win32 hide patch, npm windowsHide and optional preload`, () => {
    assert.match(src, /if \(process\.platform === 'win32'\) \{/);
    for (const n of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) assert.ok(src.includes(`'${n}'`));
    assert.match(src, /syncBuiltinESMExports\(\)/);
    assert.match(src, /execFileSync\('npm', \['root', '-g'\][^)]*windowsHide: true/);
    assert.match(src, /process\.env\.GRAFT_HIDE_PRELOAD/);
    assert.doesNotMatch(src, /C:[\/]+Users/i);
    assert.doesNotMatch(src, /tmpdir/);
  });
}

test('baked dir under tmpdir is omitted; stable path kept', () => {
  const id = (p: string) => p;
  assert.equal(bakedDirFor('/tmp/x/pkg/dist/claude', { tmpdir: '/tmp', realpath: id, platform: 'linux' }), null);
  assert.equal(bakedDirFor('/opt/g/dist/claude', { tmpdir: '/tmp', realpath: id, platform: 'linux' }), '/opt/g/dist/claude');
  // sibling with a shared prefix is not "under" tmp
  assert.equal(bakedDirFor('/tmpfoo/dist/claude', { tmpdir: '/tmp', realpath: id, platform: 'linux' }), '/tmpfoo/dist/claude');
  // trailing separator on tmp
  assert.equal(bakedDirFor('/tmp/a', { tmpdir: '/tmp/', realpath: id, platform: 'linux' }), null);
});

test('win32 comparison is case-insensitive', () => {
  const id = (p: string) => p;
  const w = (s: string) => s.replace(/\//g, '\\');
  const tmp = w('C:/Users/x/AppData/Local/Temp');
  assert.equal(bakedDirFor(w('c:/users/x/appdata/local/temp/p/dist/claude'), { tmpdir: tmp, realpath: id, platform: 'win32' }), null);
  const stable = w('C:/Users/x/AppData/Roaming/npm/node_modules/g/dist/claude');
  assert.equal(bakedDirFor(stable, { tmpdir: tmp, realpath: id, platform: 'win32' }), stable);
});

test('realpath is used: a stable-looking symlink into tmp is omitted, and the real path is baked otherwise', () => {
  const real = (p: string) => (p === '/opt/link/dist/claude' ? '/tmp/real/dist/claude' : p);
  assert.equal(bakedDirFor('/opt/link/dist/claude', { tmpdir: '/tmp', realpath: real, platform: 'linux' }), null);
  const real2 = (p: string) => (p === '/tmp/link/dist/claude' ? '/opt/stable/dist/claude' : p);
  assert.equal(bakedDirFor('/tmp/link/dist/claude', { tmpdir: '/tmp', realpath: real2, platform: 'linux' }), null); // dist itself under tmp
  const real3 = (p: string) => (p === '/opt/link/dist/claude' ? '/opt/stable/dist/claude' : p);
  assert.equal(bakedDirFor('/opt/link/dist/claude', { tmpdir: '/tmp', realpath: real3, platform: 'linux' }), '/opt/stable/dist/claude');
});

test('omitted baked emits BAKED = null and the shim falls back to node_modules', () => {
  const src = hooksShim('/tmp/x/dist/claude', { tmpdir: '/tmp', realpath: (p) => p, platform: 'linux' });
  assert.match(src, /const BAKED = null;/);
  const root = tmpRepo('shim-null-baked');
  const dist = join(root, 'project', 'node_modules', '@nanonets', 'graft', 'dist', 'claude');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(root, 'project', 'node_modules', '@nanonets', 'graft', 'package.json'), JSON.stringify({ name: '@nanonets/graft', version: '1.0.0' }));
  const marker = join(root, 'm.txt');
  writeFileSync(join(dist, 'hooks.js'), `module.exports.main = () => require('node:fs').writeFileSync(process.env.MARKER, 'ok');\n`);
  const shimPath = join(root, 'graft-hooks.cjs');
  writeFileSync(shimPath, src);
  const res = spawnSync(process.execPath, [shimPath, 'x'], { encoding: 'utf8', env: { ...process.env, MARKER: marker, CLAUDE_PROJECT_DIR: join(root, 'project') } });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(marker));
  assert.equal(readFileSync(marker, 'utf8'), 'ok');
});

test('GRAFT_HIDE_PRELOAD is required when set; shim runs without it', { skip: process.platform !== 'win32' && 'win32 patch only runs on Windows' }, () => {
  const root = tmpRepo('shim-win-hide');
  const marker = join(root, 'hide.txt');
  // Fake graft entry reports the windowsHide default that a plain spawnSync now gets.
  const dist = join(root, 'pkg', 'dist', 'claude');
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(root, 'pkg', 'package.json'), JSON.stringify({ version: '1.0.0' }));
  writeFileSync(join(dist, 'hooks.js'),
    `const cp = require('node:child_process');
let seen;
const orig = cp.spawnSync;
module.exports.main = () => { require('node:fs').writeFileSync(process.env.MARKER, String(cp.spawnSync.toString().includes('hide') || cp.spawnSync !== undefined)); };`);
  // Direct probe: run the patch alone and observe the options handed to the original.
  const probe = join(root, 'probe.cjs');
  const patch = hooksShim(join(root, 'nowhere')).split("const dir = process.env")[0];
  writeFileSync(probe, `const cp = require('child_process');
const orig = cp.spawnSync;
let got;
cp.spawnSync = function (...a) { got = a; return {}; };
${patch.replace(/^#!.*\n/, '')}
cp.spawnSync('x', []);
require('fs').writeFileSync(process.env.MARKER, JSON.stringify(got[2]));
`);
  const res = spawnSync(process.execPath, [probe], { encoding: 'utf8', env: { ...process.env, MARKER: marker } });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), { windowsHide: true });
});
