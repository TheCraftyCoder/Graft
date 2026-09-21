/**
 * Lightweight active layer for Codex-style CLI agents. Writes the shared hook
 * shim plus edit/turn-end freshness hooks; retrieval stays on-demand through
 * skills/MCP instead of being injected into every session or prompt.
 */
import { writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hooksShim } from '../claude/shim-template.js';
import { claudeDistDir } from '../claude/paths.js';
import type { PlannedWrite } from './plan.js';
import { writeOwned, isGraftEntry, readJsonObject, type ConfigWrite } from './config-write.js';

function dirExists(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * The files installing the Codex hook would touch — pure, no writes. Both live
 * under `~/.codex`, so both are scoped 'global': the hook entries fire in every
 * repo opened with Codex, not just this one. Empty when the CLI isn't installed,
 * mirroring `installCodexHooks`' early return.
 */
export function hookTargets(home: string): PlannedWrite[] {
  const base = join(home, '.codex');
  if (!dirExists(base)) return [];
  return [
    {
      hostId: 'agents', id: 'codex-hook-shim',
      path: join(base, 'hooks', 'graft', 'graft-hooks.cjs'),
      scope: 'global', kind: 'hook', what: 'post-edit hook shim',
    },
    {
      hostId: 'agents', id: 'codex-hooks',
      path: join(base, 'hooks.json'),
      scope: 'global', kind: 'hook', what: 'PostToolUse / Stop',
    },
  ];
}

/**
 * Lightweight Codex active layer. Structural retrieval is model-invoked through
 * the skill/MCP; hooks only keep the graph fresh after edits and sync once at
 * turn end. Legacy event names remain only so re-init removes Graft-owned
 * SessionStart/UserPromptSubmit entries without touching foreign hooks.
 */
const GRAFT_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'] as const;
type GraftEvent = typeof GRAFT_EVENTS[number];
interface DesiredEntry { event: GraftEvent; matcher?: string; sub: string; timeout: number; }
function desiredEntries(): DesiredEntry[] {
  return [
    { event: 'PostToolUse', matcher: 'apply_patch|Write|Edit|MultiEdit', sub: 'post-edit', timeout: 10000 },
    { event: 'Stop', sub: 'stop', timeout: 10000 },
  ];
}

export function installCodexHooks(home: string): ConfigWrite[] {
  const targets = hookTargets(home);
  if (targets.length === 0) return [];

  const shimPath = targets[0].path;
  const shimWrite = writeOwned('codex-hook-shim', shimPath, hooksShim(claudeDistDir()), 0o755);
  const cfgPath = targets[1].path;
  const skipped: ConfigWrite = { id: 'codex-hooks', path: cfgPath, action: 'skipped-unparseable' };

  const loaded = readJsonObject(cfgPath);
  if (loaded === 'unparseable') return [shimWrite, skipped];
  const { root, existed } = loaded;
  const before = JSON.stringify(root);
  const hooks = (root.hooks ??= {});
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return [shimWrite, skipped];

  for (const event of GRAFT_EVENTS) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) return [shimWrite, skipped];
  }
  const desired = new Map<GraftEvent, DesiredEntry>(desiredEntries().map((d) => [d.event, d]));
  for (const event of GRAFT_EVENTS) {
    const prior: unknown[] = Array.isArray(hooks[event]) ? hooks[event] : [];
    const foreign = prior.filter((e) => !isGraftEntry(e));
    const d = desired.get(event);
    if (!d) {
      if (foreign.length) hooks[event] = foreign;
      else delete hooks[event];
      continue;
    }
    const handler = { type: 'command', command: `node "${shimPath}" ${d.sub}`, timeout: d.timeout };
    const entry = d.matcher ? { matcher: d.matcher, hooks: [handler] } : { hooks: [handler] };
    hooks[event] = [...foreign, entry];
  }

  if (JSON.stringify(root) === before) return [shimWrite, { id: 'codex-hooks', path: cfgPath, action: 'unchanged' }];
  writeFileSync(cfgPath, `${JSON.stringify(root, null, 2)}\n`);
  return [shimWrite, { id: 'codex-hooks', path: cfgPath, action: existed ? 'updated' : 'created' }];
}
