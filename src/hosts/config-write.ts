/**
 * Shared helpers for the host config writers. Both the hook installers (Codex,
 * user-level under `~/.codex`; Cursor, repo-local under `.cursor`) and the MCP
 * registration merge graft entries into a JSON config, own a generated shim, and
 * describe the outcome with the same little result record. The file-owning write,
 * the graft-entry test, and the load-or-skip JSON open are identical across them;
 * the merge itself differs per host, so only the genuinely-shared pieces live here.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

/** The result of one config/shim write, reported by every installer and by MCP
 *  registration so they speak the same vocabulary. `McpWrite` aliases this. */
export interface ConfigWrite {
  id: string;
  path: string;
  action: 'created' | 'updated' | 'unchanged' | 'skipped-unparseable';
}

/**
 * Write a graft-owned file, idempotently: unchanged when the content already
 * matches (only re-applying `mode` if it drifted), else created/updated. `mode`
 * is applied on POSIX; on Windows the exec bit does not exist and is skipped by
 * the caller's expectations.
 */
export function writeOwned(id: string, path: string, content: string, mode?: number): ConfigWrite {
  const existed = existsSync(path);
  if (existed && readFileSync(path, 'utf8') === content) {
    if (mode !== undefined && (statSync(path).mode & 0o777) !== mode) chmodSync(path, mode);
    return { id, path, action: 'unchanged' };
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode !== undefined) chmodSync(path, mode);
  return { id, path, action: existed ? 'updated' : 'created' };
}

/** Path tails of every shim location any Graft version has written. */
const GRAFT_SHIM_SUFFIXES = [
  '/.claude/helpers/graft-hooks.cjs', // repo + legacy user-level Claude
  '/.codex/hooks/graft/graft-hooks.cjs', // Codex
  '/.cursor/hooks/graft-hooks.cjs', // Cursor (repo)
];

/** Split a shell command into words, honouring single/double quotes. */
function shellWords(cmd: string): string[] {
  const words: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

/** True when the command runs `node <graft shim> ...` (the script argument, not a mention). */
function commandRunsGraftShim(cmd: unknown): boolean {
  if (typeof cmd !== 'string') return false;
  const words = shellWords(cmd);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++; // env assignments
  const exe = words[i]?.replaceAll('\\', '/').split('/').pop()?.toLowerCase();
  if (exe !== 'node' && exe !== 'node.exe') return false;
  i++;
  while (i < words.length && words[i].startsWith('-')) i++; // node flags
  const script = words[i]?.replaceAll('\\', '/');
  return !!script && GRAFT_SHIM_SUFFIXES.some((suf) => script.endsWith(suf) || script === suf.slice(1));
}

/** Whether a hooks-config entry is one graft installed (so an upgrade replaces
 *  it in place instead of stacking a second copy next to the stale one). Only a
 *  hook command that executes one of Graft's shim paths counts; a foreign hook
 *  that merely mentions the filename is never Graft-owned. Never throws. */
export function isGraftEntry(entry: unknown): boolean {
  try {
    if (typeof entry !== 'object' || entry === null) return false;
    const e = entry as Record<string, unknown>;
    if (commandRunsGraftShim(e.command)) return true;
    if (Array.isArray(e.hooks)) {
      return e.hooks.some((h) => typeof h === 'object' && h !== null && commandRunsGraftShim((h as Record<string, unknown>).command));
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Load a JSON config that graft is about to merge into, distinguishing the three
 * outcomes an installer must treat differently:
 *   - missing → `{ root: {}, existed: false }`: start fresh, this is a create.
 *   - a plain object → `{ root, existed: true }`: merge into it.
 *   - anything else (parse error, or a top-level array/null/primitive) →
 *     `'unparseable'`: leave the file exactly as the user left it.
 *
 * Deliberately NOT `readJson` from `util/state.ts`, which returns `null` for both
 * missing and unparseable — collapsing those two would let a create silently
 * clobber a hand-edited broken `hooks.json`.
 */
export function readJsonObject(
  path: string,
): { root: Record<string, any>; existed: boolean } | 'unparseable' {
  if (!existsSync(path)) return { root: {}, existed: false };
  let root: unknown;
  try {
    root = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return 'unparseable';
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return 'unparseable';
  return { root: root as Record<string, any>, existed: true };
}
