/**
 * User-level Claude Code fallback.
 *
 * Repo-local .mcp.json can disappear in worktrees when JSON files are ignored.
 * A user-scope MCP registration lives outside the repo and keeps Graft available
 * without injecting hooks into every Claude Code session.
 *
 * We still inspect ~/.claude/settings.json during init only to remove Graft-owned
 * global hooks written by older versions. No new user-level hooks or hook shim are
 * installed.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mergeGraftHooks } from '../claude/settings-merge.js';
import { readJsonObject, type ConfigWrite } from './config-write.js';
import { mergeJsonKey, serverEntry } from './mcp-config.js';
import type { PlannedWrite } from './plan.js';

/** Same { id, path, action } contract every other writer in this layer reports. */
export type GlobalWrite = ConfigWrite;

/** Legacy location, retained so uninstall can remove shims written by old versions. */
export function globalHelpersDir(home: string): string {
  return join(home, '.claude', 'helpers');
}

/**
 * Global targets: settings cleanup plus the user-scope MCP fallback.
 * The settings target is migration-only; a fresh install does not create it.
 */
export function claudeGlobalTargets(home: string): PlannedWrite[] {
  const g = (id: string, path: string, kind: PlannedWrite['kind'], what: string): PlannedWrite =>
    ({ hostId: 'claude', id, path, scope: 'global', kind, what });
  return [
    g('claude-global-hooks', join(home, '.claude', 'settings.json'), 'hook', 'remove legacy Graft hooks'),
    g('claude-global-mcp', join(home, '.claude.json'), 'mcp', 'mcpServers.graft'),
  ];
}

/** Remove old Graft hook blocks from user settings, preserving everything else. */
function cleanGlobalHooks(id: string, path: string): GlobalWrite {
  const loaded = readJsonObject(path);
  if (loaded === 'unparseable') return { id, path, action: 'skipped-unparseable' };
  const { root: existing, existed } = loaded;
  const before = JSON.stringify(existing);
  const { merged } = mergeGraftHooks(existing, '');
  if (JSON.stringify(merged) === before) return { id, path, action: 'unchanged' };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`);
  return { id, path, action: existed ? 'updated' : 'created' };
}

/**
 * Clean legacy global hooks, then ensure the user-scope MCP registration exists.
 * No user-level hook shim is generated.
 */
export function installClaudeGlobal(home: string): GlobalWrite[] {
  const [settings, mcp] = claudeGlobalTargets(home);
  const out: GlobalWrite[] = [];

  try {
    out.push(cleanGlobalHooks(settings.id, settings.path));
  } catch {
    out.push({ id: settings.id, path: settings.path, action: 'skipped-unparseable' });
  }

  try {
    out.push(mergeJsonKey(mcp.id, mcp.path, 'mcpServers', serverEntry()));
  } catch {
    out.push({ id: mcp.id, path: mcp.path, action: 'skipped-unparseable' });
  }

  return out;
}
