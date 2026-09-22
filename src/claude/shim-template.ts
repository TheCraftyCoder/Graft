import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { win32 as pathWin32, posix as pathPosix } from 'node:path';

// Generates the tiny `.cjs` shims committed into a repo's `.claude/helpers/`. Their only
// job is to locate the installed `@nanonets/graft` package's `dist/claude/<entry>.js` and
// call into it — so the real logic lives in the package and upgrades with it.
//
// Candidates, cheapest first (no subprocess for 1–3):
//   1. `bakedDir`   — the absolute `dist/claude` graft was running from at init time.
//                     Correct with zero guesswork for whoever ran `graft init`.
//   2. repo node_modules — a local dev-dep install.
//   3. `execDir/../lib`  — the cheap legacy guess (covers nvm / classic prefix layout).
//   4. `npm root -g`     — authoritative global dir, layout-agnostic. Only shelled out to
//                     when 1–3 all miss; queried on demand — no on-disk cache, which on a
//                     shared machine would be a world-writable path an attacker could point
//                     at their own code for us to import.
//
// Among the candidates that exist we take the HIGHEST VERSION, not the first hit. First-hit
// silently pinned users to a stale graft forever: `bakedDir` points into one Node install's
// global node_modules, so switching Node versions (nvm/volta) or moving the install leaves
// the old directory on disk and still winning, and `npm i -g @nanonets/graft@latest`
// upgrades a directory the shim never looks at. The upgrade appeared to work and changed
// nothing — the shim kept loading the version from whenever `graft init` was last run.
export interface BakedOpts {
  tmpdir?: string;
  realpath?: (p: string) => string;
  platform?: NodeJS.Platform;
}

function normPath(p: string, platform: NodeJS.Platform): string {
  let n = (platform === 'win32' ? pathWin32 : pathPosix).resolve(p);
  if (platform === 'win32') n = n.toLowerCase();
  return n.endsWith(sepFor(platform)) ? n : n + sepFor(platform);
}
function sepFor(platform: NodeJS.Platform): string { return platform === 'win32' ? '\\' : '/'; }

/**
 * The dir to bake into a shim, or null when it must be omitted: the REAL location
 * (symlinks resolved) is under the OS temp dir, so it would be a dead path later.
 * Returns the realpath'd dir otherwise.
 */
export function bakedDirFor(dist: string, opts: BakedOpts = {}): string | null {
  const platform = opts.platform ?? process.platform;
  const realpath = opts.realpath ?? ((p: string) => realpathSync(p));
  let real = dist;
  try { real = realpath(dist); } catch { /* missing → keep as given */ }
  let tmp = opts.tmpdir ?? tmpdir();
  let tmpReal = tmp;
  try { tmpReal = realpath(tmp); } catch { /* keep */ }
  const r = normPath(real, platform);
  const d = normPath(dist, platform);
  for (const t of [tmp, tmpReal]) {
    const nt = normPath(t, platform);
    if (r.startsWith(nt) || d.startsWith(nt)) return null;
  }
  return real;
}

function shim(entryFile: string, call: string, bakedDir: string, opts?: BakedOpts): string {
  const baked = bakedDirFor(bakedDir, opts);
  return `#!/usr/bin/env node
// Optional preload (env GRAFT_HIDE_PRELOAD=<file>); the shim works without it.
if (process.env.GRAFT_HIDE_PRELOAD) { try { require(process.env.GRAFT_HIDE_PRELOAD); } catch {} }
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execFileSync } = require('child_process');

// Windows: force every child process spawned by a Graft hook/statusline helper to start hidden.
// Override even an explicit windowsHide:false so hook descendants cannot flash a console window.
// Resync the ESM bindings because dist/claude/*.js imports child_process through ESM.
if (process.platform === 'win32') {
  const cp = require('child_process');
  // exec/execSync take (cmd[, options][, cb]); the spawn/execFile family take
  // (file[, args][, options][, cb]). Placeholders (undefined/null) are replaced; a callback
  // in the options slot gets the options inserted before it.
  const hide = (name, args) => {
    const hasArgsSlot = name !== 'exec' && name !== 'execSync';
    const optIdx = hasArgsSlot && Array.isArray(args[1]) ? 2 : 1;
    const cur = args[optIdx];
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      args[optIdx] = { ...cur, windowsHide: true };
    } else if (typeof cur === 'function') {
      args.splice(optIdx, 0, { windowsHide: true });
    } else {
      while (args.length < optIdx) args.push(undefined);
      args[optIdx] = { windowsHide: true };
    }
    return args;
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
    const orig = cp[name];
    cp[name] = function (...args) { return orig.apply(this, hide(name, args)); };
  }
  require('module').syncBuiltinESMExports();
}
const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const BAKED = ${JSON.stringify(baked)};

// The dist/claude dir of @nanonets/graft resolved from a base whose node_modules is searched.
function fromPkg(base) {
  try {
    const pkg = require.resolve('@nanonets/graft/package.json', { paths: [base] });
    return path.join(path.dirname(pkg), 'dist', 'claude');
  } catch { return null; }
}

// The global node_modules dir per npm (handles Homebrew/Windows/volta). Queried on demand.
function globalRoot() {
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: process.platform === 'win32', windowsHide: true }).trim();
    return root || null;
  } catch { return null; /* npm unavailable */ }
}

// The version of the package a dist/claude dir belongs to, or null if unreadable.
function versionOf(distClaude) {
  try {
    return JSON.parse(fs.readFileSync(path.join(distClaude, '..', '..', 'package.json'), 'utf8')).version || null;
  } catch { return null; }
}

// Numeric-dotted compare of the release part; an unreadable version loses to any known one.
function newer(a, b) {
  if (!a) return false;
  if (!b) return true;
  const p = (v) => String(v).split('-')[0].split('.').map((n) => Number(n) || 0);
  const pa = p(a), pb = p(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

// The highest-versioned dir in \`dirs\` that actually contains \`name\`, or null.
function best(dirs, name) {
  let bestDir = null, bestVer = null;
  for (const d of dirs) {
    if (!d || !fs.existsSync(path.join(d, name))) continue;
    const v = versionOf(d);
    if (bestDir === null || newer(v, bestVer)) { bestDir = d; bestVer = v; }
  }
  return bestDir;
}

function entry(name) {
  // Cheap candidates first, and only shell out to npm when every one of them misses.
  const cheap = [BAKED, fromPkg(dir), fromPkg(path.join(path.dirname(process.execPath), '..', 'lib'))];
  const hit = best(cheap, name);
  if (hit) return path.join(hit, name);
  const gr = globalRoot();
  const global = gr && path.join(gr, '@nanonets', 'graft', 'dist', 'claude');
  if (global && fs.existsSync(path.join(global, name))) return path.join(global, name);
  return path.join(dir, 'dist', 'claude', name); // last-ditch; import will no-op if absent
}

import(pathToFileURL(entry(${JSON.stringify(entryFile)})).href).then((m) => ${call}).catch(() => { /* graft unavailable — no-op */ });
`;
}

export function statuslineShim(bakedDir: string, opts?: BakedOpts): string { return shim('statusline.js', 'm.main()', bakedDir, opts); }
export function hooksShim(bakedDir: string, opts?: BakedOpts): string { return shim('hooks.js', 'm.main(process.argv[2])', bakedDir, opts); }
