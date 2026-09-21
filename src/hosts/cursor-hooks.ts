/**
 * Lightweight Cursor project hooks (https://cursor.com/docs/hooks): edit +
 * turn-end freshness only. Retrieval stays on-demand through skills/MCP.
 *
 * Unlike the Codex hooks (which live under `~/.codex` and fire in every repo),
 * Cursor project hooks are **repo-local**: `.cursor/hooks.json` + a shim under
 * `.cursor/hooks/`. That matches graft's Cursor-only posture — a `--no-global`
 * init that never writes outside the repo — so these are scoped 'repo' and are
 * NOT suppressed by `--global false`; only `--no-hooks` skips them.
 *
 * The shim is the same one Claude Code and Codex use (`hooksShim`): it locates
 * the installed `@nanonets/graft` package and calls `hooks.js`' `main(argv[2])`,
 * so the sub-command in each entry (`cursor-post-tool`, `cursor-mcp`,
 * `cursor-session-end`) routes to the matching handler in `../claude/hooks.ts`.
 *
 * Events, confirmed against the Cursor hooks docs (the matcher/tool-name shape
 * is load-bearing, so it is read from the docs, not guessed):
 *   - `postToolUse` (matcher `Read|Grep|Glob|Search|Shell`) → classify a source read
 *     vs a graft-CLI Shell call; MCP tools are skipped here so they aren't
 *     double-counted against `afterMCPExecution`.
 *   - `afterMCPExecution` → the graft MCP calls, savings parsed from `result_json`.
 *   - `sessionEnd` → roll the closed session up into `session_summary` as Cursor.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hooksShim } from '../claude/shim-template.js';
import { claudeDistDir } from '../claude/paths.js';
import type { PlannedWrite } from './plan.js';
import { writeOwned, isGraftEntry, readJsonObject, type ConfigWrite } from './config-write.js';

/** The Cursor hooks.json schema version graft writes. */
const CURSOR_HOOKS_VERSION = 1;

function shimPathFor(repo: string): string {
  return join(repo, '.cursor', 'hooks', 'graft-hooks.cjs');
}
function configPathFor(repo: string): string {
  return join(repo, '.cursor', 'hooks.json');
}

/**
 * The files a Cursor-hooks install would touch — pure, no writes. Both are
 * repo-local, so both are scoped 'repo' (they fire only in this repo, matching
 * the Cursor-only, no-global init). Always returns the pair: unlike Codex there
 * is no "is the CLI installed" gate — the repo's own `.cursor/` is what we write.
 */
export function cursorHookTargets(repo: string): PlannedWrite[] {
  return [
    {
      hostId: 'cursor', id: 'cursor-hook-shim',
      path: shimPathFor(repo),
      scope: 'repo', kind: 'hook', what: 'session-scoring hook shim',
    },
    {
      hostId: 'cursor', id: 'cursor-hooks',
      path: configPathFor(repo),
      scope: 'repo', kind: 'hook', what: 'afterFileEdit / stop',
    },
  ];
}

/**
 * Lightweight Cursor active layer. afterFileEdit marks the graph dirty and stop
 * performs one background sync. Legacy telemetry event names remain only so
 * upgrades remove Graft-owned entries from older installs.
 */
const GRAFT_EVENTS = ['postToolUse', 'afterMCPExecution', 'sessionEnd', 'afterFileEdit', 'stop'] as const;
type GraftEvent = typeof GRAFT_EVENTS[number];
interface DesiredEntry { event: GraftEvent; matcher?: string; sub: string; }
function desiredEntries(): DesiredEntry[] {
  return [
    { event: 'afterFileEdit', sub: 'post-edit' },
    { event: 'stop', sub: 'stop' },
  ];
}

/**
 * Install (or refresh) graft's Cursor project hooks in `repo`. Idempotent, and
 * conservative with a hand-edited config: an unparseable or wrong-shaped
 * `hooks.json` is left exactly as-is (reported `skipped-unparseable`) rather than
 * clobbered. Foreign hook entries are preserved; a stale graft entry is replaced
 * so an upgrade re-points to the current shim/sub-command instead of stacking.
 */
export function installCursorHooks(repo: string): ConfigWrite[] {
  const shimPath = shimPathFor(repo);
  const shimWrite = writeOwned('cursor-hook-shim', shimPath, hooksShim(claudeDistDir()), 0o755);
  const cfgPath = configPathFor(repo);
  const skipped: ConfigWrite = { id: 'cursor-hooks', path: cfgPath, action: 'skipped-unparseable' };

  const loaded = readJsonObject(cfgPath);
  if (loaded === 'unparseable') return [shimWrite, skipped];
  const { root, existed } = loaded;
  const before = JSON.stringify(root);
  if (root.version === undefined) root.version = CURSOR_HOOKS_VERSION;
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
    const command = `node "${shimPath}" ${d.sub}`;
    const entry = d.matcher ? { matcher: d.matcher, command } : { command };
    hooks[event] = [...foreign, entry];
  }

  if (JSON.stringify(root) === before) return [shimWrite, { id: 'cursor-hooks', path: cfgPath, action: 'unchanged' }];
  writeFileSync(cfgPath, `${JSON.stringify(root, null, 2)}\n`);
  return [shimWrite, { id: 'cursor-hooks', path: cfgPath, action: existed ? 'updated' : 'created' }];
}
