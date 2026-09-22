/**
 * Register the graft MCP server in each host's config.
 * JSON hosts get a keyed merge (other servers preserved; unparseable files
 * are never rewritten). The TOML host gets an append-if-absent section.
 *
 * `mcpTargets()` is the pure "which files would this touch" half, so `graft
 * init --dry-run` and the picker can report paths without writing;
 * `registerMcpConfigs()` walks that same list to do the writing.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { PlannedWrite } from './plan.js';
import { readJsonObject, type ConfigWrite } from './config-write.js';

/** MCP registration reports the same write-result record every installer does. */
export type McpWrite = ConfigWrite;

/** A planned MCP write, plus the detail needed to actually perform it. */
export interface McpTarget extends PlannedWrite {
  format: 'json' | 'toml';
  /** JSON only: the top-level key holding the server map. */
  topKey?: string;
  /** JSON only: the server entry to merge in under `graft`. */
  entry?: object;
}

/**
 * How to launch the MCP server, decided once at init time.
 *
 * `npx -y` resolves the package before it can serve: measured at a 211 ms
 * spawn→`initialize` handshake against 80 ms for the installed binary, five runs
 * each. The harness registers a server's tools only once that handshake lands, and
 * a slow one can miss the first request entirely — in a traced session graft's
 * tools arrived 13.9 s in, four model turns too late to shape the approach. (That
 * 13.9 s is NOT explained by 130 ms; the gap's cause is still unknown. This is the
 * cheap half of the fix, not the whole of it.)
 *
 * Deliberately a bare command name, never an absolute path: these files get
 * committed and shared, and this repo already carries the scar of the alternative —
 * a checked-in hook shim with another machine's home directory baked into it. A
 * bare `graft` works on any machine that has it installed; `npx` remains the
 * fallback for machines that don't.
 */
const NPX_LAUNCH = { command: 'npx', args: ['-y', '@nanonets/graft', 'mcp'] };
const BIN_LAUNCH = { command: 'graft', args: ['mcp'] };

/** Injectable environment for launcher detection, so tests never touch the real machine. */
export interface LauncherDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  spawn: (cmd: string, args: string[], opts: SpawnSyncOptions) => { status: number | null };
  exists: (p: string) => boolean;
}

const defaultDeps = (): LauncherDeps => ({
  platform: process.platform,
  env: process.env,
  spawn: (cmd, args, opts) => spawnSync(cmd, args, opts),
  exists: (p) => existsSync(p),
});

/** Characters that could break out of the quoted cmd.exe command string. */
const UNSAFE_CMD_CHARS = /["&|^%<>!\r\n]/;

/**
 * Windows: npm installs `graft` as an extensionless script plus `graft.cmd`/`.ps1`,
 * none of which `spawnSync('graft')` can start without a shell. Resolve the launcher
 * by scanning PATH x PATHEXT in-process, then run `--version` on that absolute path.
 * `.cmd`/`.bat` need cmd.exe; its command string is built only from the resolved
 * path (unsafe characters rejected) and the constant `--version`.
 */
function windowsGraftUsable(deps: LauncherDeps): boolean {
  const pathVar = deps.env.PATH ?? deps.env.Path ?? '';
  const exts = (deps.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  for (const dir of pathVar.split(';')) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir.replace(/^"|"$/g, ''), `graft${ext.toLowerCase()}`);
      if (!deps.exists(candidate)) continue;
      if (UNSAFE_CMD_CHARS.test(candidate)) return false;
      const lower = candidate.toLowerCase();
      if (lower.endsWith('.exe') || lower.endsWith('.com')) {
        return deps.spawn(candidate, ['--version'], { stdio: 'ignore', timeout: 5000, windowsHide: true }).status === 0;
      }
      if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) continue;
      const r = deps.spawn(
        deps.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', `"${candidate}" --version`],
        { stdio: 'ignore', timeout: 5000, windowsHide: true, windowsVerbatimArguments: true },
      );
      return r.status === 0;
    }
  }
  return false;
}

function graftOnPath(deps: LauncherDeps = defaultDeps()): boolean {
  if (deps.platform === 'win32') return windowsGraftUsable(deps);
  return deps.spawn('graft', ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
}

/**
 * Pick the launcher. Precedence: `GRAFT_MCP_NPX` truthy (forces npx), then
 * `GRAFT_MCP_LAUNCHER=graft|npx` (deterministic override; other values ignored),
 * then `onPath` if given, then probing for an installed `graft`.
 * Exported with injectable deps for tests.
 */
export function detectGraftLauncher(
  deps: Partial<LauncherDeps> = {},
  onPath?: boolean,
): { command: string; args: string[] } {
  const d = { ...defaultDeps(), ...deps };
  const forced = d.env.GRAFT_MCP_NPX;
  if (forced !== undefined && forced !== '' && forced !== '0' && forced !== 'false') return NPX_LAUNCH;
  const override = d.env.GRAFT_MCP_LAUNCHER;
  if (override === 'graft') return BIN_LAUNCH;
  if (override === 'npx') return NPX_LAUNCH;
  return (onPath ?? graftOnPath(d)) ? BIN_LAUNCH : NPX_LAUNCH;
}

/**
 * JSON hosts: `{ command, args }`.
 *
 * `GRAFT_MCP_NPX=1` forces the `npx` form — the escape hatch for a machine whose
 * global install is stale or shadowed, and what the tests set so their expectations
 * don't depend on whether the machine running them happens to have graft installed.
 * `GRAFT_MCP_LAUNCHER=graft|npx` is a deterministic override (GRAFT_MCP_NPX still
 * wins). `opts.onPath` is the same override for direct unit tests of both branches.
 */
export function serverEntry(opts: { onPath?: boolean } = {}): { command: string; args: string[] } {
  return detectGraftLauncher({}, opts.onPath);
}


function opencodeEntry(): object {
  const { command, args } = serverEntry();
  return { type: 'local', command: [command, ...args], enabled: true };
}

function dirExists(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function mergeJsonKey(id: string, path: string, topKey: string, entry: object): McpWrite {
  const loaded = readJsonObject(path);
  if (loaded === 'unparseable') return { id, path, action: 'skipped-unparseable' };
  const { root, existed } = loaded;
  const bucket = (root[topKey] ??= {});
  if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) {
    return { id, path, action: 'skipped-unparseable' };
  }
  if (JSON.stringify(bucket.graft) === JSON.stringify(entry)) return { id, path, action: 'unchanged' };
  const action = existed ? 'updated' : 'created';
  bucket.graft = entry;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return { id, path, action };
}

/** The `[mcp_servers.graft]` table header, as written and as matched. */
const TOML_HEADER = '[mcp_servers.graft]';

/**
 * Remove the `[mcp_servers.graft]` table from a TOML config, returning the rest.
 *
 * Line-based on purpose: a real parse-and-reserialize would reformat the user's
 * whole file. The table runs from its header to the next `[`-header or EOF, which
 * is exactly the shape {@link upsertCodexToml} appends. Exported so the writer and
 * `retract.ts` can never disagree about what "graft's section" means.
 */
export function stripTomlSection(text: string): { rest: string; found: boolean } {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.trim() === TOML_HEADER);
  if (start === -1) return { rest: text, found: false };
  let end = start + 1;
  while (end < lines.length && !lines[end].trimStart().startsWith('[')) end++;
  const rest = [...lines.slice(0, start), ...lines.slice(end)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '');
  return { rest, found: true };
}

/**
 * Register graft in a TOML config, replacing any section a previous version left.
 *
 * The old behaviour was to skip entirely once the header existed, which froze the
 * launch command at whatever the first init wrote: a repo wired when graft wasn't
 * on PATH kept the slow `npx` form forever, and no upgrade could correct it. Strip
 * and re-append instead, so this converges like every other writer — foreign
 * tables are untouched either way.
 */
function upsertCodexToml(id: string, path: string): McpWrite {
  const existed = existsSync(path);
  const text = existed ? readFileSync(path, 'utf8') : '';
  const { command, args } = serverEntry();
  const argList = args.map((a) => JSON.stringify(a)).join(", ");
  const section = `${TOML_HEADER}\ncommand = \"${command}\"\nargs = [${argList}]\n`;

  const { rest, found } = stripTomlSection(text);
  // Byte-identical already: don't rewrite the file just to reorder it.
  if (found && text === appendSection(rest, section)) return { id, path, action: 'unchanged' };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, appendSection(rest, section));
  return { id, path, action: existed ? 'updated' : 'created' };
}

/** Append a section after exactly one blank line, or at the top of an empty file. */
function appendSection(text: string, section: string): string {
  if (text.trim() === '') return section;
  const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${sep}${section}`;
}

function jsonTarget(
  hostId: string,
  id: string,
  path: string,
  topKey: string,
  entry: object,
  scope: PlannedWrite['scope'] = 'repo',
): McpTarget {
  return { hostId, id, path, scope, kind: 'mcp', what: `${topKey}.graft`, format: 'json', topKey, entry };
}

/**
 * The MCP config files selecting these hosts would touch — pure, no writes.
 * Codex's target is the user-level `~/.codex/config.toml`, so it is scoped
 * 'global': registering there affects every project on the machine.
 */
export function mcpTargets(
  repo: string,
  ids: string[],
  opts: { home?: string } = {},
): McpTarget[] {
  const home = opts.home ?? homedir();
  const entry = serverEntry();
  const out: McpTarget[] = [];
  for (const id of ids) {
    switch (id) {
      case 'cursor':
        out.push(jsonTarget(id, id, join(repo, '.cursor', 'mcp.json'), 'mcpServers', entry));
        break;
      case 'gemini':
        out.push(jsonTarget(id, id, join(repo, '.gemini', 'settings.json'), 'mcpServers', entry));
        break;
      case 'antigravity':
        // Antigravity reads MCP from its OWN registry, separate from Gemini CLI's
        // `.gemini/settings.json` — a global `~/.gemini/config/mcp_config.json` (the
        // gap #62 reported). Standard `{command,args}` under `mcpServers`. Global
        // scope: it applies to every workspace opened in Antigravity.
        out.push(
          jsonTarget(id, 'antigravity', join(home, '.gemini', 'config', 'mcp_config.json'), 'mcpServers', entry, 'global'),
        );
        break;
      case 'kiro':
        out.push(jsonTarget(id, id, join(repo, '.kiro', 'settings', 'mcp.json'), 'mcpServers', entry));
        break;
      case 'grok':
        // Grok reads MCP from repo-level `.grok/config.toml` (`[mcp_servers.<name>]`),
        // the same TOML shape Codex uses at ~/.codex/config.toml.
        out.push({
          hostId: id, id: 'grok', path: join(repo, '.grok', 'config.toml'),
          scope: 'repo', kind: 'mcp', what: '[mcp_servers.graft]', format: 'toml',
        });
        break;
      case 'agents':
        // Guarded on the CLI actually being installed, so a plan only ever
        // lists files a real run would touch.
        if (dirExists(join(home, '.codex'))) {
          out.push({
            hostId: id, id: 'codex', path: join(home, '.codex', 'config.toml'),
            scope: 'global', kind: 'mcp', what: '[mcp_servers.graft]', format: 'toml',
          });
        }
        if (dirExists(join(home, '.config', 'opencode'))) {
          out.push(jsonTarget(id, 'opencode', join(repo, 'opencode.json'), 'mcp', opencodeEntry()));
        }
        break;
      default:
        break; // copilot / windsurf / adal: no MCP target in this phase
    }
  }
  return out;
}

export function registerMcpConfigs(
  repo: string,
  ids: string[],
  opts: { home?: string; global?: boolean } = {},
): McpWrite[] {
  return mcpTargets(repo, ids, opts)
    .filter((t) => opts.global !== false || t.scope !== 'global')
    .map((t) =>
      t.format === 'toml'
        ? upsertCodexToml(t.id, t.path)
        : mergeJsonKey(t.id, t.path, t.topKey!, t.entry!),
    );
}
