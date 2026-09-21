/**
 * What `graft init` *would* write, computed before anything is written.
 *
 * The picker and `--dry-run` both need the exact path list up front, so every
 * writer in the init path (instruction files, MCP configs, hooks, the Claude
 * Code layer) exposes a pure `*Targets()` function and then consumes that same
 * list to do its writing. One source of truth, so a plan can never drift from
 * what a real run touches.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { statSync } from 'node:fs';
import { HOSTS, detectHosts, type DetectProbe, type HostTarget } from './registry.js';
import { mcpTargets } from './mcp-config.js';
import { hookTargets } from './codex-hooks.js';
import { cursorHookTargets } from './cursor-hooks.js';
import { antigravitySkillTargets } from './antigravity.js';
import { claudeTargets } from '../claude/init.js';
import { claudeGlobalTargets } from './claude-global.js';
import { planRetract, changed, type Retraction } from './retract.js';

/** Where a write lands. 'global' = outside the repo, affects every project. */
export type WriteScope = 'repo' | 'global';

export interface PlannedWrite {
  /** The selectable host this write belongs to ('claude', 'agents', 'cursor', …). */
  hostId: string;
  /** Reporting id — differs from hostId where one host writes several configs
   *  (the 'agents' host covers both 'codex' and 'opencode'). */
  id: string;
  path: string;
  scope: WriteScope;
  kind: 'instruction' | 'mcp' | 'hook' | 'claude' | 'skill';
  /** Short human label for what changes in that file. */
  what: string;
}

export interface HostPlan {
  id: string;
  name: string;
  detected: boolean;
  writes: PlannedWrite[];
}

function probeFor(home: string, repo: string): DetectProbe {
  return {
    home, repo,
    dirExists: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
  };
}

/** The instruction-file write for one host, derived from its registry entry. */
function instructionTarget(repo: string, host: HostTarget): PlannedWrite {
  return {
    hostId: host.id,
    id: host.id,
    path: join(repo, host.relPath),
    scope: 'repo',
    kind: 'instruction',
    what: host.kind === 'owned' ? 'graft-owned file' : 'fenced graft section',
  };
}

/**
 * Every host graft can wire, each with the full set of files selecting it would
 * touch. Claude Code comes first — it's the deep integration and the picker's
 * default. `ids`, when given, restricts the plan to those hosts.
 */
export function planInit(repo: string, opts: { home?: string; ids?: string[] } = {}): HostPlan[] {
  const home = opts.home ?? homedir();
  const probe = probeFor(home, repo);
  const detected = new Set(detectHosts(probe).map((h) => h.id));

  const plans: HostPlan[] = [
    // Repo writes plus the user-level MCP fallback/settings cleanup — the picker and
    // `--dry-run` render global writes separately so the user sees what lands
    // outside the repo before agreeing to it.
    { id: 'claude', name: 'Claude Code', detected: true, writes: [...claudeTargets(repo), ...claudeGlobalTargets(home)] },
    ...HOSTS.map((host) => ({
      id: host.id,
      name: host.name,
      detected: detected.has(host.id),
      writes: [
        instructionTarget(repo, host),
        ...mcpTargets(repo, [host.id], { home }),
        ...(host.id === 'agents' ? hookTargets(home) : []),
        ...(host.id === 'cursor' ? cursorHookTargets(repo) : []),
        ...(host.id === 'antigravity' ? antigravitySkillTargets(home) : []),
      ],
    })),
  ];

  return opts.ids ? plans.filter((p) => opts.ids!.includes(p.id)) : plans;
}

/** Flatten a plan down to the writes for the selected host ids. */
export function selectedWrites(plan: HostPlan[], ids: string[]): PlannedWrite[] {
  return plan.filter((p) => ids.includes(p.id)).flatMap((p) => p.writes);
}

/** The flags that decide which planned writes a real graft init performs. */
export interface OperationOpts {
  home?: string;
  mcp?: boolean;
  hooks?: boolean;
  global?: boolean;
  statusline?: boolean;
  preserve?: boolean;
}

/**
 * Whether the real run performs this write under the flags. The one filter
 * runHostsInit and planOperations share, so they cannot drift.
 * Claude Code's own layer (runInit) honours only global: it writes its
 * .mcp.json and settings hook blocks regardless of --no-mcp / --no-hooks, and it
 * writes the statusline shim and settings.json even under --no-statusline (the
 * flag only changes what the settings block contains).
 */
export function writeAllowed(
  w: Pick<PlannedWrite, 'hostId' | 'kind' | 'scope'>,
  opts: Pick<OperationOpts, 'mcp' | 'hooks' | 'global'>,
): boolean {
  if (opts.global === false && w.scope === 'global') return false;
  if (w.hostId === 'claude') return true;
  if (opts.mcp === false && w.kind === 'mcp') return false;
  if (opts.hooks === false && w.kind === 'hook') return false;
  return true;
}

export interface PlannedOperations {
  writes: PlannedWrite[];
  retractions: Retraction[];
}

/**
 * Everything a real graft init for ids would change under these flags:
 * the writes, and the unselected-host retractions (none under --preserve).
 * Pure — touches nothing.
 */
export function planOperations(repo: string, ids: string[], opts: OperationOpts = {}): PlannedOperations {
  const home = opts.home ?? homedir();
  const writes = selectedWrites(planInit(repo, { home }), ids).filter((w) => writeAllowed(w, opts));
  const retractions = opts.preserve
    ? []
    : changed(planRetract(repo, { home, exclude: ids, global: opts.global, cache: false })).filter(
        (r) => r.action !== 'skipped-unparseable',
      );
  return { writes, retractions };
}
