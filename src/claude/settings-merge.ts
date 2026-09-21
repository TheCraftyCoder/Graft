import { isGraftEntry } from '../hosts/config-write.js';

type Json = Record<string, any>;

const SL_CMD = 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/graft-statusline.cjs"';
/** Stable marker for "this statusLine is Graft's", not the full command string —
 * an older shim path or a GRAFT_DIR wrapper still names this file. */
const GRAFT_STATUSLINE_HELPER = 'graft-statusline.cjs';
const FOOTER = 'graft/[\\w./-]+\\.md';
// Every form graft is actually invoked as. 'graft:*' covers a global install;
// the other two cover a repo working on graft itself (or any consumer running it
// from a checkout), where the binary is not on PATH under that name. A retrieval
// call that raises a permission prompt loses to grep, which never does.
const ALLOW_ENTRIES = [
  'Bash(graft:*)',
  'Bash(npx graft:*)',
  'Bash(graft-dev:*)',
  'Bash(node dist/cli.js:*)',
];

/** Where the repo-level install's shims sit, relative to whatever project is open. */
const REPO_HELPERS = '${CLAUDE_PROJECT_DIR:-.}/.claude/helpers';
const GRAFT_HOOK_EVENTS = ['PostToolUse', 'UserPromptSubmit', 'SessionStart', 'Stop'] as const;

/**
 * `helpers` is the directory holding `graft-hooks.cjs`, and it is a parameter for
 * one reason: the user-level install (see hosts/claude-global.ts) has to name an
 * absolute path. A `${CLAUDE_PROJECT_DIR}` command works only where a previous
 * `graft init` wrote a shim into that project — which is exactly the case the
 * global copy exists to cover, so it cannot reuse the repo form.
 */
function hookCmd(arg: string, helpers: string = REPO_HELPERS): string {
  return `node "${helpers}/graft-hooks.cjs" ${arg}`;
}
function graftBlocks(helpers?: string): Record<string, Json[]> {
  return {
    PostToolUse: [
      { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: hookCmd('post-edit', helpers), timeout: 10000 }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: hookCmd('stop', helpers), timeout: 8000 }] }],
  };
}

/**
 * Is this allowlist entry one graft wrote?
 *
 * Scoped to the forms graft is actually invoked as — NOT any rule mentioning
 * "graft". A user who allowlists their own `Bash(graft-mytool:*)` keeps it; only
 * graft's own set is replaced, which is what lets a renamed entry disappear on
 * upgrade instead of accumulating beside its replacement.
 */
export function isGraftAllowEntry(entry: unknown): boolean {
  return /^Bash\((?:graft|npx graft|graft-dev|node dist\/cli\.js)(?::|\))/.test(String(entry));
}

/** Is this footer regex graft's? It points at the card tree, which is graft's alone. */
export function isGraftFooterRegex(re: unknown): boolean {
  return String(re).includes('graft/');
}

function envNoStatusline(): boolean {
  const v = process.env.GRAFT_NO_STATUSLINE;
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

/** True when init should write (or refresh) Graft's Claude Code statusLine. */
export function statuslineWanted(opts: { statusline?: boolean } = {}): boolean {
  return opts.statusline !== false && !envNoStatusline();
}

function isGraftStatusline(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const command = (value as Json).command;
  return typeof command === 'string' && command.includes(GRAFT_STATUSLINE_HELPER);
}

function applyStatusline(
  merged: Json,
  key: 'statusLine' | 'subagentStatusLine',
  warnings: string[],
  wanted: boolean,
  foreignWarning: string,
): void {
  const current = merged[key];
  const ours = isGraftStatusline(current);
  if (!wanted) {
    if (!current || ours) delete merged[key];
    else warnings.push(foreignWarning);
    return;
  }
  if (!current || ours) {
    merged[key] = { type: 'command', command: SL_CMD };
    return;
  }
  warnings.push(foreignWarning);
}

export function mergeGraftSettings(
  existing: Json,
  opts: { statusline?: boolean } = {},
): { merged: Json; warnings: string[] } {
  const merged: Json = { ...(existing ?? {}) };
  const warnings: string[] = [];
  const wanted = statuslineWanted(opts);

  applyStatusline(
    merged, 'statusLine', warnings, wanted,
    'Existing statusLine left untouched (a session allows only one). To use Graft, point it at .claude/helpers/graft-statusline.cjs.',
  );
  applyStatusline(
    merged, 'subagentStatusLine', warnings, wanted,
    'Existing subagentStatusLine left untouched.',
  );

  merged.hooks = { ...(merged.hooks ?? {}) };
  const blocks = graftBlocks();
  for (const event of GRAFT_HOOK_EVENTS) {
    const prior = Array.isArray(merged.hooks[event]) ? merged.hooks[event] : [];
    const foreign = prior.filter((e: Json) => !isGraftEntry(e));
    const next = [...foreign, ...(blocks[event] ?? [])];
    if (next.length) merged.hooks[event] = next;
    else delete merged.hooks[event];
  }
  if (Object.keys(merged.hooks).length === 0) delete merged.hooks;

  // Drop graft's own prior regex before re-adding, so a change to FOOTER replaces
  // the old pattern instead of stacking beside it. The user's regexes are kept.
  const priorFooter = Array.isArray(merged.footerLinksRegexes) ? merged.footerLinksRegexes : [];
  merged.footerLinksRegexes = [...priorFooter.filter((r: unknown) => !isGraftFooterRegex(r)), FOOTER];

  // headless/subagent runs hard-deny Bash by default; without an allowlist entry
  // `graft ask`'s own Bash calls (and the skill it installs) can't run out-of-box.
  // Same shape as the hooks merge above: drop graft's prior entries, then add the
  // current set. Append-only left a renamed invocation form in the user's settings
  // forever, with nothing able to remove it.
  merged.permissions = { ...(merged.permissions ?? {}) };
  const priorAllow = Array.isArray(merged.permissions.allow) ? merged.permissions.allow : [];
  merged.permissions.allow = [...priorAllow.filter((e: unknown) => !isGraftAllowEntry(e)), ...ALLOW_ENTRIES];

  return { merged, warnings };
}

/**
 * Remove Graft-owned user-level hooks while preserving every foreign hook.
 * Project-level post-edit + Stop hooks are sufficient; the user-scope MCP
 * registration remains the worktree fallback without injecting hooks globally.
 */
export function mergeGraftHooks(existing: Json, _helpers: string): { merged: Json } {
  const merged: Json = { ...(existing ?? {}) };
  merged.hooks = { ...(merged.hooks ?? {}) };
  for (const event of GRAFT_HOOK_EVENTS) {
    const prior = Array.isArray(merged.hooks[event]) ? merged.hooks[event] : [];
    const foreign = prior.filter((e: Json) => !isGraftEntry(e));
    if (foreign.length) merged.hooks[event] = foreign;
    else delete merged.hooks[event];
  }
  if (Object.keys(merged.hooks).length === 0) delete merged.hooks;
  return { merged };
}
