/**
 * `graft search` — the P3 orchestrator: fuses `ask`'s lexical/graph ranking
 * with ColGREP's semantic hits (mapped onto graph symbol nodes), then
 * reciprocal-rank-fuses the two lists.
 *
 * Kicks `ask` (sync, CPU-bound) and `runColgrep` (async subprocess, I/O-bound)
 * off together so the subprocess's wall-clock time overlaps the lexical rank
 * instead of stacking behind it. Never throws for a missing/failing ColGREP
 * binary — that degrades to the `ask`-only path plus one note line.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { loadGraphCached } from "../graph/load.js";
import { ask, type AskHit, type AskResult } from "../ask/ask.js";
import { assertPrefixIndexed, pathUnderPrefix } from "../graph/scopes.js";
import { normalizePathPrefix } from "../util/paths.js";
import type { GraphV1, NodeV1 } from "../graph/types.js";
import { runColgrep, type ColgrepHit } from "./colgrep.js";
import { mapHitsToNodes, fuseSearch, isTestPath, type AskSearchHit, type SearchCandidate } from "./hybrid.js";

/** Generic test-path segment names/globs passed to ColGREP as
 * `--exclude-dir`/`--exclude` when `includeTests` is off, so ColGREP's own
 * scan skips them rather than relying purely on the post-fetch filter in
 * `fuseSearch` (kept as a safety net — see `search()`). Mirrors
 * `hybrid.ts`'s `isTestPath` segment/suffix set. */
const COLGREP_TEST_EXCLUDE_DIRS = ["test", "tests", "__tests__", "__mocks__", "e2e", "testdata", "fixtures", "spec"];
const COLGREP_TEST_EXCLUDE_GLOBS = ["*.test.*", "*.spec.*", "*.stories.*", "*_test.go", "*_test.ts"];

/**
 * Rejects a `--in` value before any ColGREP subprocess is spawned: an
 * absolute path (never a valid repo-relative prefix, whatever it resolves
 * to), or a normalized prefix that resolves outside `root` (`..`,
 * `../outside`, a different drive). Throws with the raw value named in the
 * message either way — a caller mistake here is a typo or a copy-pasted
 * absolute path, not a legitimate query to run.
 *
 * The outside-root check is segment-aware: `rel` must literally BE `".."` or
 * start with a `".."` path segment (`".." + sep` or `"../"`) to count as
 * escaping — a plain `rel.startsWith("..")` would also rejct a real,
 * indexed directory whose name merely starts with two dots, e.g. `..generated`,
 * whose `relative()` result (`"..generated"`) would falsely reject as an
 * escape — it starts with the two characters `".."` but is not the
 * parent-directory segment `".."` at all.
 */
function assertInWithinRoot(root: string, rawIn: string, normalizedPrefix: string): void {
  if (isAbsolute(rawIn)) {
    throw new Error(`--in must be a repo-relative path, not an absolute path: "${rawIn}"`);
  }
  const resolved = resolve(root, normalizedPrefix);
  const rel = relative(root, resolved);
  if (rel === ".." || rel.startsWith(".." + sep) || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`--in resolves outside the repo root: "${rawIn}"`);
  }
}

export interface SearchOptions {
  /** Max results in the fused list (default 10). */
  limit?: number;
  /** Narrow to nodes under this path prefix (segment-aware, like `ask --in`).
   * Validated up front — an absolute path or a prefix resolving outside the
   * repo root throws before any ColGREP subprocess runs (see
   * `assertInWithinRoot`). */
  in?: string;
  /** Keep test/spec/e2e paths (dropped by default). */
  includeTests?: boolean;
  json?: boolean;
  /** RRF k (default 60, delegated to `fuseSearch`). */
  k?: number;
  /** ColGREP retrieval mode: `"hybrid"` (default — ColGREP's own default,
   * semantic + keyword together), `"semantic"` (adds `--semantic-only`), or
   * `"off"` (skip ColGREP entirely — `ask`-only, `semanticUsed` always
   * false, and `note` says so without implying a failure). */
  colgrepMode?: "hybrid" | "semantic" | "off";
  /** Semantic-call duration (ms) above which a successful `note` explains
   * a slow ColGREP index refresh instead of staying silent. Default 10000. */
  slowSemanticMs?: number;
  /** Same override `ask`/`skeleton`/the MCP tools accept: loads the graph
   * (and routes the internal `ask` call) from this context dir instead of
   * the default `<dir>/graft`. Mirrors `ask`'s own `--dir`/`dirOverride`
   * plumbing exactly, so `graft search` respects the same workspace and
   * custom-context-dir setup as every other command. */
  contextDir?: string;
  /** Environment forwarded to the ColGREP subprocess (`runColgrep`/
   * `detectColgrep`). Default `process.env`. Lets a caller (tests, or a
   * custom ColGREP install via `GRAFT_COLGREP_BIN`) route the subprocess
   * without mutating the real `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface SearchResult {
  results: SearchCandidate[];
  note?: string;
  semanticUsed: boolean;
  /** `ask`: the synchronous `ask()` call's own CPU time. `wall`: total
   * elapsed time for the parallel ask+colgrep phase (from just before both
   * are kicked off to when the colgrep promise settles). `semantic` is
   * derived as `wall - ask` rather than measured inside the ColGREP
   * subprocess itself (colgrep.ts's own timing is out of this module's
   * reach) — it is the parallel wall time NOT attributable to `ask`, not a
   * true in-process measurement of the subprocess's own duration. */
  timingsMs: { ask: number; semantic: number; wall: number };
}

const COLGREP_UNAVAILABLE_NOTE = "colgrep unavailable (not found on PATH or failed); showing lexical/graph results";
const COLGREP_DISABLED_NOTE = "colgrep disabled (colgrepMode: \"off\"); showing lexical/graph results";

/** `"path:L<a>-L<b>"` (symbol/caller/callee) or a bare `path` (file-kind
 * node). Mirrors `ask.ts`'s own (unexported) `parseSpan`. */
const POINTER_SPAN_RE = /^(.*):L(\d+)-L(\d+)$/;

function nodeForPointer(graph: GraphV1 | null, pointer: string): NodeV1 | null {
  if (!graph) return null;
  const m = POINTER_SPAN_RE.exec(pointer);
  if (m) {
    const path = m[1];
    const span = `L${m[2]}-L${m[3]}`;
    return graph.nodes.find((n) => n.path === path && n.span === span) ?? null;
  }
  return graph.nodes.find((n) => n.kind === "file" && n.path === pointer) ?? null;
}

/** A concept hit's `pointer` is a comma-joined list of its source files (or,
 * absent sources, its slug). Picks the first source that isn't a test path
 * (a concept card pointing at `foo_test.go:-` sends the agent to the test
 * instead of the definition), unless `includeTests` — then the first source,
 * as before. Returns `null` when every source is a test path and tests
 * aren't included, signalling the caller to drop the hit entirely rather
 * than surface a test-only card. Absent sources (a bare slug) return the
 * pointer unchanged, same as before — a slug is never a test path. */
function firstSourcePath(pointer: string, includeTests: boolean): string | null {
  const sources = pointer
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (sources.length === 0) return pointer;
  if (includeTests) return sources[0];
  return sources.find((p) => !isTestPath(p)) ?? null;
}

/** Converts one `AskHit` into the shape `fuseSearch` expects, resolving its
 * `pointer` back to a graph node so the fused list carries a real `nodeId`.
 * A `caller`/`callee` hit came from structural edge-walking (graph
 * traversal), not lexical/BM25 scoring, so it is tagged `fromGraph: true` —
 * `fuseSearch` uses that to tell "graph" provenance from "lexical" when a
 * node has no matching semantic hit. Returns `null` for a concept hit whose
 * every source is a test path (see {@link firstSourcePath}); the caller
 * filters those out. */
function toSearchHit(hit: AskHit, graph: GraphV1 | null, includeTests: boolean): AskSearchHit | null {
  const fromGraph = hit.kind === "caller" || hit.kind === "callee";

  if (hit.kind === "concept") {
    const path = firstSourcePath(hit.pointer, includeTests);
    if (path === null) return null;
    const node = graph?.nodes.find((n) => n.kind === "file" && n.path === path) ?? null;
    return {
      nodeId: node ? node.id : path || hit.pointer,
      path: node ? node.path : path,
      span: null,
      name: hit.title,
      kind: node ? node.kind : null,
      signature: node ? node.signature : null,
      fromGraph: false,
    };
  }

  const node = nodeForPointer(graph, hit.pointer);
  if (node) {
    return {
      nodeId: node.id,
      path: node.path,
      span: node.span,
      name: node.name,
      kind: node.kind,
      signature: node.signature,
      fromGraph,
    };
  }

  // Pointer didn't resolve to a currently-loaded node (an unresolved import
  // target, or a graph that's drifted since `ask` ran) — still surfaced,
  // keyed by the pointer itself so it dedupes sanely.
  const m = POINTER_SPAN_RE.exec(hit.pointer);
  return {
    nodeId: hit.pointer,
    path: m ? m[1] : hit.pointer,
    span: m ? `L${m[2]}-L${m[3]}` : null,
    name: hit.title,
    kind: null,
    signature: null,
    fromGraph,
  };
}

/**
 * Fuses `ask`'s ranking with ColGREP's semantic hits for `dir`/`query`. Never
 * throws for a missing/failing ColGREP binary: `semanticUsed` is then false,
 * `note` explains why, and `results` is the `ask` ranking alone (still run
 * through the same fuse/dedupe/limit path).
 */
export async function search(dir: string, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const root = resolve(dir);
  const outDir = contextDirFor(root, opts.contextDir);
  const limit = opts.limit ?? 10;
  // `ask` is always fetched to at least 16 (or `limit * 2` past that),
  // regardless of the display `limit` — agreement between `ask` and ColGREP
  // (tier-1 `both`) is the strongest signal fusion has, and it must not
  // depend on the display limit: at `--limit 5` a 10-deep fetch would miss
  // an ask hit at rank 11-16 that ColGREP also found, so it never becomes
  // `both` even though the exact same query at `--limit 8` would surface it.
  // Tier-2 ask-ONLY candidates (no colgrep agreement) are still capped to
  // `askOnlyRankCap` below, so this wider fetch only ever widens `both`
  // detection — it never floods tier 2 with `ask`'s 16th-best lexical guess.
  const askLimit = Math.max(16, limit * 2);
  // Ask-only tier-2 cap: keeps the *display* behavior for ask-only hits the
  // same as before this fetch widened (old default: `Math.max(10, limit * 2)`).
  const askOnlyRankCap = Math.max(10, limit * 2);
  const includeTests = opts.includeTests ?? false;
  const colgrepMode = opts.colgrepMode ?? "hybrid";

  // The graph is loaded FIRST so `--in` can be validated before any ColGREP
  // subprocess is spawned: an absolute path, a prefix resolving outside
  // `root`, or a prefix matching nothing indexed are all caller mistakes
  // that must fail loudly, not silently kick off a whole-repo ColGREP scan
  // first and only THEN discover the scope was bad.
  const graph = loadGraphCached(outDir);
  if (!graph) {
    throw new Error("no graph found — run `graft build` first");
  }
  const inPrefix = opts.in ? normalizePathPrefix(opts.in) : undefined;
  if (opts.in && inPrefix !== undefined) {
    assertInWithinRoot(root, opts.in, inPrefix);
    if (graph) assertPrefixIndexed(graph, inPrefix);
  }

  // Scopes ColGREP itself to the `--in` subtree (resolved to an absolute path
  // under root, the way ColGREP expects its final positional argument) —
  // `pathUnderPrefix` below is still applied as a safety net, but a caller
  // that already knows the subtree it wants shouldn't pay for a whole-repo
  // ColGREP scan first. When `includeTests` is off, ColGREP is also told to
  // exclude the generic test dirs/globs itself (`COLGREP_TEST_EXCLUDE_*`);
  // the post-fetch test-path filter in `fuseSearch` stays in place as a
  // safety net for anything those generic patterns miss, so `k` no longer
  // needs the old over-fetch (25) to compensate — 15 either way.
  const colgrepTargetPath = inPrefix ? resolve(root, inPrefix) : undefined;
  const colgrepK = 15;
  const colgrepExcludeDirs = includeTests ? undefined : COLGREP_TEST_EXCLUDE_DIRS;
  const colgrepExcludeGlobs = includeTests ? undefined : COLGREP_TEST_EXCLUDE_GLOBS;

  // Kick the subprocess off first so its I/O overlaps `ask`'s synchronous
  // CPU-bound rank, then run `ask` before awaiting the subprocess. `wallT0`
  // marks the start of this parallel phase for `timingsMs.wall`. `"off"`
  // skips the subprocess entirely — resolves immediately to `null` so the
  // rest of the pipeline (timings, fusion) runs unchanged with an empty
  // colgrep list.
  const wallT0 = Date.now();
  const colgrepPromise: Promise<ColgrepHit[] | null> =
    colgrepMode === "off"
      ? Promise.resolve(null)
      : runColgrep(query, {
          cwd: root,
          k: colgrepK,
          targetPath: colgrepTargetPath,
          env: opts.env,
          mode: colgrepMode === "semantic" ? "semantic" : "hybrid",
          excludeDirs: colgrepExcludeDirs,
          excludeGlobs: colgrepExcludeGlobs,
        });

  const askT0 = Date.now();
  const askResult: AskResult = ask(dir, query, { limit: askLimit, in: opts.in, contextDir: opts.contextDir });
  const askMs = Date.now() - askT0;

  const rawColgrepHits: ColgrepHit[] | null = await colgrepPromise;
  const wallMs = Date.now() - wallT0;
  // `semantic` is not measured inside the ColGREP subprocess (colgrep.ts is
  // a pure I/O adapter with no duration on its result) — it's derived as the
  // parallel wall time left over once `ask`'s own synchronous cost is
  // subtracted, i.e. the wall-clock cost NOT attributable to `ask`.
  const semanticMs = wallMs - askMs;

  // Defensive: `ask` already honors `limit`, but this keeps the contract
  // explicit — only the top `askLimit` hits ever reach fusion.
  const askHits: AskSearchHit[] = askResult.hits
    .slice(0, askLimit)
    .map((h) => toSearchHit(h, graph, includeTests))
    .filter((h): h is AskSearchHit => h !== null);

  // `colgrepMode: "off"` is a caller's deliberate choice, not a failure —
  // `semanticUsed` stays false (nothing ran) but the note says so plainly
  // rather than implying ColGREP was tried and came up empty/missing.
  const semanticUsed = colgrepMode !== "off" && rawColgrepHits !== null;
  const slowSemanticMs = opts.slowSemanticMs ?? 10000;
  // A successful-but-slow semantic call usually means colgrep just spent
  // this query re-indexing after a large tree change (its refresh runs
  // inline with the first post-change query) — surface that instead of
  // staying silent, since the wait looks like a hang otherwise.
  const note =
    colgrepMode === "off"
      ? COLGREP_DISABLED_NOTE
      : !semanticUsed
        ? COLGREP_UNAVAILABLE_NOTE
        : semanticMs > slowSemanticMs
          ? `colgrep refreshed its index (${(semanticMs / 1000).toFixed(1)} s); repeat queries are fast`
          : undefined;
  const filteredColgrepHits =
    rawColgrepHits && inPrefix ? rawColgrepHits.filter((h) => pathUnderPrefix(h.path, inPrefix)) : rawColgrepHits;
  const semantic: SearchCandidate[] =
    filteredColgrepHits && graph ? mapHitsToNodes(graph, filteredColgrepHits) : [];

  const results = fuseSearch({
    askHits,
    semantic,
    includeTests: opts.includeTests,
    limit,
    k: opts.k,
    askOnlyRankCap,
  });

  return {
    results,
    note,
    semanticUsed,
    timingsMs: { ask: askMs, semantic: semanticMs, wall: wallMs },
  };
}
