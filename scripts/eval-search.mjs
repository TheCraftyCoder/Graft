#!/usr/bin/env node
/**
 * Generic retrieval-evaluation harness for `graft search` — scores it against
 * a hand-verified gold set for ANY repo, not just this one.
 *
 *   node scripts/eval-search.mjs <gold-file> [--dir <repo>] [--limits 5,8]
 *     [--json] [--include-tests] [--via cli|api]
 *
 * A gold file (`.json` or `.jsonl`) lists queries with the repo-relative
 * paths (optionally `path#symbol`) a human has verified from SOURCE — never
 * from the tool under test — belong in the results. Each query is scored at
 * every `--limit`:
 *
 *   HIT     — a gold path (or `path#symbol`) is in the top-N results
 *   PARTIAL — only a listed "partial" path is in the top-N
 *   MISS    — neither is
 *
 * `--via api` (default) imports this package's own built `dist/search/search.js`
 * directly; `--via cli` shells out to `dist/cli.js search --json` instead, for
 * parity checks between the two entry points. Exit code is always 0 — this is
 * a report, not a gate — unless the gold file itself is invalid.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// ── pure scoring ──────────────────────────────────────────────────────────

/** Matches one gold/partial entry (`"path"` or `"path#symbol"`) against a
 * search candidate (`{ path, name, ... }`). A bare path matches any
 * candidate at that path (file-level); `path#symbol` also requires the
 * candidate's `name` to equal the symbol. */
function matchesEntry(candidate, entry) {
  const hashIdx = entry.indexOf("#");
  if (hashIdx === -1) return candidate.path === entry;
  const path = entry.slice(0, hashIdx);
  const symbol = entry.slice(hashIdx + 1);
  return candidate.path === path && candidate.name === symbol;
}

/**
 * Scores one query's `results` (already ranked, any length) against one gold
 * entry (`{ gold: string[], partial?: string[] }`) at `limit`. Only the top
 * `limit` results are considered — a gold hit ranked below `limit` is a MISS,
 * matching what a user would actually see.
 */
export function scoreResults(results, goldEntry, limit) {
  const sliced = results.slice(0, limit);
  const gold = goldEntry.gold ?? [];
  const partial = goldEntry.partial ?? [];

  for (let i = 0; i < sliced.length; i++) {
    if (gold.some((g) => matchesEntry(sliced[i], g))) {
      return { verdict: "HIT", rank: i + 1, provenance: sliced[i].provenance ?? null };
    }
  }
  for (let i = 0; i < sliced.length; i++) {
    if (partial.some((g) => matchesEntry(sliced[i], g))) {
      return { verdict: "PARTIAL", rank: i + 1, provenance: sliced[i].provenance ?? null };
    }
  }
  return { verdict: "MISS", rank: null, provenance: null };
}

/** Validates the minimal query shape (`id`, `query`, `gold` array); throws
 * with a line-identifying message on the first violation. */
function validateQueries(queries) {
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error("gold file must contain at least one query");
  }
  queries.forEach((q, i) => {
    if (!q || typeof q !== "object") throw new Error(`query at index ${i} is not an object`);
    if (!q.id) throw new Error(`query at index ${i} is missing "id"`);
    if (!q.query) throw new Error(`query "${q.id}" is missing "query"`);
    if (!Array.isArray(q.gold)) throw new Error(`query "${q.id}" is missing a "gold" array`);
  });
}

/**
 * Parses a gold file's raw text into `{ queries: [...] }`. `ext` is `.json`
 * (one object with a top-level `queries` array) or `.jsonl` (one query
 * object per non-blank line, no wrapper). Throws a clear error — never
 * returns a partial/garbage result — for malformed JSON or the wrong shape.
 */
export function loadGold(text, ext) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("gold file is empty");

  if (ext === ".jsonl") {
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const queries = lines.map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        throw new Error(`invalid JSON on line ${i + 1} of gold file: ${e.message}`);
      }
    });
    validateQueries(queries);
    return { queries };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`invalid JSON gold file: ${e.message}`);
  }
  if (!parsed || !Array.isArray(parsed.queries)) {
    throw new Error('gold file must have a top-level "queries" array (or use .jsonl for one-object-per-line)');
  }
  validateQueries(parsed.queries);
  return parsed;
}

// ── orchestration (pure given an injected `search`) ────────────────────────

/** Renders a candidate list to the same compact text form a human/agent
 * would read, purely to measure output size — no I/O. */
function renderTopN(candidates) {
  return candidates
    .map((r, i) => `${i + 1}. ${r.path}${r.span ? ":" + r.span : ""} · ${r.name} · [${r.provenance}]`)
    .join("\n");
}

/**
 * Runs every query in `gold.queries` through `search` once (at the largest
 * requested limit) and scores the resulting ranked list at every limit —
 * `search` is called once per query, not once per (query, limit) pair, since
 * a shorter limit's results are just a prefix of the longer one's.
 *
 * `search(query, opts)` must resolve to `{ results: SearchCandidate[] }` (or
 * a bare array). Injected so this never needs a real graph or ColGREP in
 * tests — the CLI `main()` below supplies the real one.
 */
export async function runEval({ search, gold, limits = [5], includeTests = false, colgrepMode }) {
  const maxLimit = Math.max(...limits);
  const perQuery = [];

  for (const q of gold.queries) {
    const t0 = performance.now();
    const raw = await search(q.query, { limit: maxLimit, includeTests, colgrepMode });
    const ms = performance.now() - t0;
    const candidates = Array.isArray(raw) ? raw : (raw?.results ?? []);
    const topN = candidates.slice(0, maxLimit);

    const perLimit = {};
    for (const limit of limits) {
      perLimit[limit] = scoreResults(topN, q, limit);
    }

    perQuery.push({
      id: q.id,
      query: q.query,
      ms,
      outputChars: renderTopN(topN).length,
      perLimit,
    });
  }

  const totals = {};
  for (const limit of limits) {
    totals[limit] = { hit: 0, partial: 0, miss: 0 };
    for (const pq of perQuery) {
      const key = pq.perLimit[limit].verdict.toLowerCase();
      totals[limit][key]++;
    }
  }

  return { perQuery, totals, limits };
}

// ── rendering ───────────────────────────────────────────────────────────

function renderMarkdown(evalResult) {
  const lines = [];
  for (const limit of evalResult.limits) {
    lines.push(`### limit ${limit}`, "");
    lines.push("| query | verdict | rank | provenance | ms |", "| --- | --- | --- | --- | --- |");
    for (const pq of evalResult.perQuery) {
      const s = pq.perLimit[limit];
      lines.push(`| ${pq.id} | ${s.verdict} | ${s.rank ?? "-"} | ${s.provenance ?? "-"} | ${pq.ms.toFixed(1)} |`);
    }
    const t = evalResult.totals[limit];
    lines.push(`| **totals** | hit=${t.hit} partial=${t.partial} miss=${t.miss} | | | |`, "");
  }
  return lines.join("\n");
}

// ── CLI (I/O only past this point) ─────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const goldPath = positional[0];
  if (!goldPath) {
    console.error("usage: node scripts/eval-search.mjs <gold-file> [--dir <repo>] [--limits 5,8] [--json] [--include-tests] [--via cli|api] [--colgrep-mode hybrid|semantic|off]");
    process.exit(2);
  }

  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const dir = resolve(flag("dir") ?? ".");
  const limits = (flag("limits") ?? "5,8").split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const asJson = args.includes("--json");
  const includeTests = args.includes("--include-tests");
  const via = flag("via") ?? "api";
  const colgrepModeArg = flag("colgrep-mode");
  if (colgrepModeArg !== undefined && !["hybrid", "semantic", "off"].includes(colgrepModeArg)) {
    console.error(`invalid --colgrep-mode "${colgrepModeArg}"; expected hybrid | semantic | off`);
    process.exit(2);
  }
  const colgrepMode = colgrepModeArg === "semantic" || colgrepModeArg === "off" ? colgrepModeArg : undefined;

  if (!existsSync(goldPath)) {
    console.error(`gold file not found: ${goldPath}`);
    process.exit(2);
  }
  let gold;
  try {
    gold = loadGold(readFileSync(goldPath, "utf8"), extname(goldPath));
  } catch (e) {
    console.error(`invalid gold file: ${e.message}`);
    process.exit(2);
  }

  let search;
  if (via === "cli") {
    const cliPath = join(packageRoot, "dist", "cli.js");
    if (!existsSync(cliPath)) {
      console.error("run `npm run build` first (dist/cli.js not found)");
      process.exit(2);
    }
    search = (query, opts) => {
      const proc = spawnSync(
        "node",
        [
          cliPath,
          "search",
          query,
          dir,
          "--limit",
          String(opts.limit),
          "--json",
          ...(opts.includeTests ? ["--include-tests"] : []),
          ...(opts.colgrepMode ? ["--colgrep-mode", opts.colgrepMode] : []),
        ],
        { encoding: "utf8" },
      );
      if (proc.status !== 0) {
        return { results: [], note: proc.stderr };
      }
      return JSON.parse(proc.stdout);
    };
  } else {
    const searchModulePath = join(packageRoot, "dist", "search", "search.js");
    if (!existsSync(searchModulePath)) {
      console.error("run `npm run build` first (dist/search/search.js not found)");
      process.exit(2);
    }
    const { search: apiSearch } = await import(pathToFileURL(searchModulePath).href);
    search = (query, opts) =>
      apiSearch(dir, query, { limit: opts.limit, includeTests: opts.includeTests, colgrepMode: opts.colgrepMode });
  }

  const evalResult = await runEval({ search, gold, limits, includeTests, colgrepMode });

  if (asJson) {
    console.log(JSON.stringify(evalResult, null, 2));
  } else {
    console.log(renderMarkdown(evalResult));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
