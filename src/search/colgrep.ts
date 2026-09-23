/**
 * Adapter over the external `colgrep` CLI (semantic code search) — `graft
 * search` fuses these hits with the existing `ask` ranking. Pure I/O
 * wrapper: no ranking or fusion logic lives here.
 *
 * ColGREP is optional. Every failure mode (binary missing, non-zero exit,
 * timeout, unparseable output) resolves to `null` rather than throwing, so a
 * caller can always fall back to `ask` alone.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter as pathDelimiter, join as joinPath } from "node:path";

export interface ColgrepHit {
  /** Repo-relative path (forward slashes), or the normalized absolute path
   * when the hit falls outside `cwd`. */
  path: string;
  /** Normalized absolute path (forward slashes), always present. */
  absPath: string;
  line: number;
  endLine: number;
  name: string;
  /** ColGREP's own owner-qualified identity for the unit (e.g. `"User.Save"`,
   * `"services.ProcessWidget"`), when it reports one. `null` when ColGREP's
   * `qualified_name` is absent — the bare `name` plus span heuristics are all
   * `mapHitsToNodes` has to work with then. */
  qualifiedName: string | null;
  unitType: string;
  signature: string | null;
  language: string | null;
  score: number;
}

export interface ColgrepDetection {
  ok: boolean;
  version?: string;
  reason?: string;
}

export interface RunColgrepOptions {
  cwd: string;
  /** Number of hits to request. Default 15. */
  k?: number;
  /** Restrict to code units (`--code-only`). Default true. */
  codeOnly?: boolean;
  /** Default 60000. ColGREP's self-refresh after a large tree change can
   * legitimately run past ten seconds; 15s was cutting that refresh off and
   * silently dropping the semantic list for the query that triggered it. */
  timeoutMs?: number;
  /** Environment the subprocess runs with (default `process.env`). Set
   * `GRAFT_COLGREP_BIN`/`GRAFT_COLGREP_ARGS_PREFIX` here (see `envOverride`)
   * to point at a ColGREP install that isn't a native binary on PATH. */
  env?: NodeJS.ProcessEnv;
  /** Search root passed as ColGREP's final positional argument. Default
   * `"."` (repo root, matching the previous hardcoded behavior). */
  targetPath?: string;
  /** `"hybrid"` (default — ColGREP's own default: semantic + keyword) or
   * `"semantic"`, which adds `--semantic-only`. */
  mode?: "hybrid" | "semantic";
  /** Directory names to exclude, one `--exclude-dir=<d>` per entry. */
  excludeDirs?: string[];
  /** Glob patterns to exclude, one `--exclude=<g>` per entry. */
  excludeGlobs?: string[];
}

const DEFAULT_K = 15;
const DEFAULT_TIMEOUT_MS = 60000;
const DETECT_TIMEOUT_MS = 5000;

/** `detectColgrep` result cache — only used when the caller relies on
 * `process.env` (no `opts.env` override), so tests that inject a fake PATH
 * via `opts.env` never see a stale answer from an earlier real check. */
let cachedDetection: ColgrepDetection | undefined;

function debugLog(env: NodeJS.ProcessEnv, msg: string): void {
  if (env.GRAFT_DEBUG) process.stderr.write(`[colgrep] ${msg}\n`);
}

interface ResolvedCommand {
  command: string;
  args: string[];
}

/** `resolveCommand` failed to find a usable native binary — a reason, never
 * a fallback command. Distinguishes "resolved to something we refuse to run"
 * (a `.cmd`/`.bat` shim) from "nothing found" (falls through to the bare
 * command name so the ordinary ENOENT path still fires). */
interface ResolveError {
  error: string;
}

type ResolveResult = ResolvedCommand | ResolveError;

function isResolveError(r: ResolveResult): r is ResolveError {
  return "error" in r;
}

const NATIVE_EXTENSIONS = new Set([".exe", ".com"]);
const SHELL_SCRIPT_EXTENSIONS = new Set([".cmd", ".bat"]);

/** Bypasses PATH/PATHEXT resolution entirely: spawns `GRAFT_COLGREP_BIN`
 * instead of resolving `"colgrep"`. Honored on every call (not test-only) —
 * a real escape hatch for a ColGREP install that isn't a native binary on
 * PATH (a wrapper script, a non-standard location). `GRAFT_COLGREP_ARGS_PREFIX`
 * is a JSON array of argv entries inserted before ColGREP's own flags
 * (default `[]`) — e.g. a wrapper script's own path when `GRAFT_COLGREP_BIN`
 * points at an interpreter rather than the tool itself. A malformed
 * `GRAFT_COLGREP_ARGS_PREFIX` (not JSON, or not a JSON array) is ignored,
 * falling back to `[]`, rather than throwing. */
function envOverride(env: NodeJS.ProcessEnv): { binaryPath: string; binaryPrelude: string[] } | undefined {
  const binaryPath = env.GRAFT_COLGREP_BIN;
  if (!binaryPath) return undefined;
  let binaryPrelude: string[] = [];
  const raw = env.GRAFT_COLGREP_ARGS_PREFIX;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) binaryPrelude = parsed;
    } catch {
      /* malformed override — fall back to no prefix */
    }
  }
  return { binaryPath, binaryPrelude };
}

/**
 * Windows only: resolves `command` against `PATH`/`PATHEXT` by hand, native
 * binaries only.
 *
 * Node's non-shell `spawn` on Windows resolves a bare command name to a
 * native `.exe`/`.com` automatically (real ColGREP, a Rust binary, needs
 * nothing more than that — confirmed against the actual `colgrep.exe`), but
 * it never searches `PATHEXT` for `.cmd`/`.bat`. ColGREP ships as a native
 * binary, so a resolved `.cmd`/`.bat` is never a legitimate ColGREP install —
 * treat it as "not found" (an error, distinct from "nothing on PATH at all")
 * rather than shelling out to it. There is deliberately no `cmd.exe`
 * fallback here: a query string reaching `cmd.exe /c` unquoted (or
 * hand-quoted with an incomplete metacharacter set) is a command-injection
 * path, and a native binary never needs one.
 */
function resolveWindowsCommand(command: string, args: string[], env: NodeJS.ProcessEnv): ResolveResult {
  const pathext = (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  const dirs = (env.PATH || env.Path || "").split(pathDelimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of pathext) {
      const lowerExt = ext.toLowerCase();
      if (!NATIVE_EXTENSIONS.has(lowerExt) && !SHELL_SCRIPT_EXTENSIONS.has(lowerExt)) continue;
      const candidate = joinPath(dir, command + ext);
      if (!existsSync(candidate)) continue;
      if (SHELL_SCRIPT_EXTENSIONS.has(lowerExt)) {
        return { error: "colgrep resolved to a shell script; only a native binary is supported" };
      }
      return { command: candidate, args };
    }
  }
  // Nothing found by hand either — fall through to the bare name so the
  // ordinary ENOENT path still fires and error handling stays in one place.
  return { command, args };
}

function resolveCommand(command: string, args: string[], env: NodeJS.ProcessEnv): ResolveResult {
  const override = envOverride(env);
  if (override) {
    return { command: override.binaryPath, args: [...override.binaryPrelude, ...args] };
  }
  return process.platform === "win32" ? resolveWindowsCommand(command, args, env) : { command, args };
}

/** Runs `colgrep --version` to answer "is ColGREP usable here". Cached per
 * process unless `opts.env` is passed (tests inject a fake PATH this way and
 * must never see a cached answer from a different environment). */
export function detectColgrep(opts: { env?: NodeJS.ProcessEnv } = {}): ColgrepDetection {
  if (!opts.env && cachedDetection) return cachedDetection;
  const env = opts.env ?? process.env;
  const result = detectColgrepUncached(env);
  if (!opts.env) cachedDetection = result;
  return result;
}

function detectColgrepUncached(env: NodeJS.ProcessEnv): ColgrepDetection {
  try {
    const resolved = resolveCommand("colgrep", ["--version"], env);
    if (isResolveError(resolved)) {
      debugLog(env, `detect: ${resolved.error}`);
      return { ok: false, reason: resolved.error };
    }
    const res = spawnSync(resolved.command, resolved.args, {
      encoding: "utf8",
      timeout: DETECT_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
      env,
    });
    if (res.error) {
      debugLog(env, `detect: spawn error: ${res.error.message}`);
      return { ok: false, reason: res.error.message };
    }
    if (res.signal || res.status !== 0) {
      debugLog(env, `detect: exited code=${res.status} signal=${res.signal}`);
      return { ok: false, reason: `exited with code ${res.status ?? "null"} signal ${res.signal ?? "null"}` };
    }
    const version = res.stdout?.trim();
    if (!version) return { ok: false, reason: "empty --version output" };
    return { ok: true, version };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    debugLog(env, `detect: threw: ${reason}`);
    return { ok: false, reason };
  }
}

/** `\\?\` long-path prefix off, then every backslash to `/`. Idempotent on
 * an already-posix path. */
function normalizeSlashes(p: string): string {
  let out = p.startsWith("\\\\?\\") ? p.slice(4) : p;
  if (out.includes("\\")) out = out.replace(/\\/g, "/");
  return out;
}

/** `to` made relative to `from`, both already forward-slash-normalized
 * absolute paths. Segment-based rather than `node:path`'s `posix.relative`
 * because a Windows absolute path normalized to `C:/Users/...` is not a
 * POSIX-absolute path (no leading `/`) and would be misread as relative.
 * Returns a string starting with `..` when `to` is not under `from` (e.g. a
 * different drive) — callers treat that as "outside cwd" and never render
 * the value itself. */
function relativeSlashPath(fromPath: string, toPath: string): string {
  const fromParts = fromPath.split("/").filter(Boolean);
  const toParts = toPath.split("/").filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const upCount = fromParts.length - i;
  const downParts = toParts.slice(i);
  const rel = [...Array(upCount).fill(".."), ...downParts].join("/");
  return rel === "" ? "." : rel;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Maps one raw ColGREP result (`{ unit: {...}, score }`) to a `ColgrepHit`.
 * Returns null for a malformed entry (missing `unit.file`) rather than
 * throwing — one bad entry never fails the whole batch. */
function normalizeHit(raw: unknown, cwdNorm: string): ColgrepHit | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const uRaw = r.unit;
  const u = uRaw && typeof uRaw === "object" ? (uRaw as Record<string, unknown>) : {};
  const rawFile = asString(u.file);
  if (!rawFile) return null;

  const absPath = normalizeSlashes(rawFile);
  const rel = relativeSlashPath(cwdNorm, absPath);
  const path = rel.startsWith("..") ? absPath : rel;
  const line = asNumber(u.line) ?? 0;

  return {
    path,
    absPath,
    line,
    endLine: asNumber(u.end_line) ?? line,
    name: asString(u.name) ?? "",
    qualifiedName: asString(u.qualified_name) ?? null,
    unitType: asString(u.unit_type) ?? "",
    signature: asString(u.signature) ?? null,
    language: asString(u.language) ?? null,
    score: asNumber(r.score) ?? 0,
  };
}

/**
 * Runs `colgrep --json [--code-only] -k <k> -n 0 <query> <targetPath>` in
 * `opts.cwd` and returns its hits sorted by score descending (stable — ties
 * keep ColGREP's own order). Never throws: any failure (binary missing,
 * non-zero exit, malformed output, timeout) resolves to `null`.
 */
export async function runColgrep(query: string, opts: RunColgrepOptions): Promise<ColgrepHit[] | null> {
  const k = opts.k ?? DEFAULT_K;
  const codeOnly = opts.codeOnly ?? true;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = opts.env ?? process.env;
  const targetPath = opts.targetPath ?? ".";

  const args = ["--json"];
  if (codeOnly) args.push("--code-only");
  if (opts.mode === "semantic") args.push("--semantic-only");
  for (const d of opts.excludeDirs ?? []) args.push(`--exclude-dir=${d}`);
  for (const g of opts.excludeGlobs ?? []) args.push(`--exclude=${g}`);
  args.push("-k", String(k), "-n", "0", query, targetPath);

  return new Promise<ColgrepHit[] | null>((resolvePromise) => {
    let settled = false;
    // Declared before the try/catch below (which can call `finish(null)`
    // early, before the timer exists) so `finish`'s `clearTimeout(timer)`
    // never reads a not-yet-initialized `const` — that threw a
    // ReferenceError after `settled = true` was already set, silently
    // swallowing the error and leaving `resolvePromise` never called (the
    // promise hung forever).
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: ColgrepHit[] | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise(result);
    };

    let child: ChildProcess;
    try {
      const resolved = resolveCommand("colgrep", args, env);
      if (isResolveError(resolved)) {
        debugLog(env, resolved.error);
        finish(null);
        return;
      }
      child = spawn(resolved.command, resolved.args, { cwd: opts.cwd, env, windowsHide: true, shell: false });
    } catch (err) {
      debugLog(env, `spawn threw: ${err instanceof Error ? err.message : String(err)}`);
      finish(null);
      return;
    }

    timer = setTimeout(() => {
      debugLog(env, `timed out after ${timeoutMs}ms`);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      finish(null);
    }, timeoutMs);
    timer.unref?.();

    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk;
    });

    child.on("error", (err) => {
      debugLog(env, `spawn error: ${err.message}`);
      finish(null);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      if (signal || code !== 0) {
        debugLog(env, `exited code=${code ?? "null"} signal=${signal ?? "null"}`);
        finish(null);
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        debugLog(env, "output was not valid JSON");
        finish(null);
        return;
      }
      if (!Array.isArray(parsed)) {
        debugLog(env, "output was not a JSON array");
        finish(null);
        return;
      }

      const cwdNorm = normalizeSlashes(opts.cwd);
      const hits: ColgrepHit[] = [];
      for (const raw of parsed) {
        const hit = normalizeHit(raw, cwdNorm);
        if (hit) hits.push(hit);
      }
      // Array#sort is stable (spec-guaranteed since ES2019): equal-score hits
      // keep ColGREP's own order.
      hits.sort((a, b) => b.score - a.score);
      finish(hits);
    });
  });
}
