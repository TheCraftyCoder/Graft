#!/usr/bin/env node
/**
 * Generic retrieval-evaluation harness for `graft search` — scores it against
 * a hand-verified gold set for ANY repo, not just this one.
 *
 *   node scripts/eval-search.mjs <gold-file> [--dir <repo>] [--limits 5,8]
 *     [--json] [--include-tests] [--via cli|api] [--colgrep-mode hybrid|semantic|off]
 *     [--k <n>] [--arms off,hybrid,semantic,samefile-tier2,samefile-off,rrf-order,no-graphrank]
 *     [--check-gold]
 *
 * `--check-gold` validates the gold file's `required`/`partial` entries
 * against the graph on disk for `--dir` (no searches run): a bare path with
 * no indexed node is "FILE NOT INDEXED"; a `path#symbol` entry whose path has
 * nodes but none named `symbol` is "SYMBOL NOT INDEXED" (with up to 3
 * candidate names at that path as hints). Prints one line per problem to
 * stderr and exits 1 if any, 0 if none.
 *
 * A gold file (`.json` or `.jsonl`) lists queries verified from SOURCE — never
 * from the tool under test. Each query has `required` (an array of groups;
 * every group must be satisfied, any member of a group satisfies it) and an
 * optional `partial` list of paths/`path#symbol` that are useful but
 * incomplete evidence:
 *
 *   { "id": "q1", "query": "...",
 *     "required": ["path/a.ts", ["path/b.ts", "path/b.ts#Symbol"]],
 *     "partial": ["path/d.ts"] }
 *   { "id": "q2", "query": "...",
 *     "required": ["path/c.ts"], "acceptable": ["path/c-legacy.ts"] }
 *
 * A `required` element is a string (a one-item group) or an array of strings
 * (equivalent alternatives — any one satisfies the group), and every member
 * must be a non-empty string; the same entry string can't appear in two
 * different groups (a path and its `path#symbol` form in different groups
 * are NOT duplicates — a single result may legitimately satisfy both).
 * `acceptable` is only allowed when `required` has exactly one group
 * (otherwise which group it extends is ambiguous, so it's an error) and
 * never together with legacy `gold`; its items are appended to that group.
 * The legacy shape `"gold": [...]` (no `required`) becomes a single
 * required group with the old any-item-satisfies semantics — `gold` and
 * `required` together is an error. A bare path matches any candidate at that
 * path (file-level); `path#symbol` also requires the candidate's `name` to
 * equal the symbol.
 *
 * Every (query, limit[, arm]) is scored as its own `search()` call at that
 * limit — never a prefix slice of a longer run. Per query per limit:
 *
 *   requiredFound / requiredGroups  — group-level Recall@k
 *   allRequired                     — every group satisfied within the limit
 *   firstRelevantRank               — first rank satisfying any group (null if none)
 *   completeRank                    — last group's first-satisfying rank, only when allRequired
 *   reciprocalRank                  — 1 / firstRelevantRank, else 0 (rolls up to MRR)
 *   verdict: HIT (allRequired) | PARTIAL (some group, or a `partial` hit) | MISS
 *
 * `--arms <names>` runs the same queries through named presets (colgrep mode
 * and/or an internal `_ablation` combination — see `ARM_PRESETS`) and adds an
 * arm × limit comparison table. `_ablation` arms are `--via api`-only (the
 * CLI has no flag for them) — combined with `--via cli` they're a usage
 * error. `--k <n>` (RRF constant) applies to every arm.
 *
 * `--via api` (default) imports this package's own built `dist/search/search.js`
 * directly and searches the graph on disk as-is; `--via cli` shells out to
 * `dist/cli.js search --json` instead, which refreshes the graph before
 * searching — for parity checks between the two entry points. Exit code is
 * 0 for a completed report, 2 for an invalid gold file or CLI arguments, or
 * 1 if a `search()` call itself fails (e.g. a `--via cli` invocation exits
 * non-zero).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// ── schema normalization ────────────────────────────────────────────────────

/** Normalizes one raw gold-file query object into `{ id, query, required:
 * string[][], partial: string[] }`. Throws a query-identifying error on any
 * invalid shape — never returns a partial/garbage result. */
export function normalizeQuery(q, index) {
  if (!q || typeof q !== "object") throw new Error(`query at index ${index} is not an object`);
  if (!q.id) throw new Error(`query at index ${index} is missing "id"`);
  if (!q.query) throw new Error(`query "${q.id}" is missing "query"`);

  const hasRequired = Object.prototype.hasOwnProperty.call(q, "required");
  const hasGold = Object.prototype.hasOwnProperty.call(q, "gold");
  if (hasGold && hasRequired) {
    throw new Error(`query "${q.id}" has both "gold" (legacy) and "required" — use only one`);
  }

  /** Every member of `group` must be a non-empty string. */
  function assertStringMembers(group, field) {
    for (const s of group) {
      if (typeof s !== "string" || s.length === 0) {
        throw new Error(`query "${q.id}" ${field} must contain only non-empty strings`);
      }
    }
  }

  let required;
  if (hasRequired) {
    if (!Array.isArray(q.required) || q.required.length === 0) {
      throw new Error(`query "${q.id}" has an invalid "required" (must be a non-empty array)`);
    }
    required = q.required.map((group, gi) => {
      if (typeof group === "string") {
        assertStringMembers([group], `required[${gi}]`);
        return [group];
      }
      if (Array.isArray(group) && group.length > 0 && group.every((s) => typeof s === "string")) {
        assertStringMembers(group, `required[${gi}]`);
        return group.slice();
      }
      throw new Error(`query "${q.id}" required[${gi}] must be a string or a non-empty array of strings`);
    });
  } else if (hasGold) {
    if (!Array.isArray(q.gold) || q.gold.length === 0) {
      throw new Error(`query "${q.id}" is missing a "gold" array`);
    }
    assertStringMembers(q.gold, `"gold"`);
    required = [q.gold.slice()];
    // "acceptable" belongs to the "required" schema (it's appended to
    // required's one group below) — with legacy "gold" there is no
    // "required" group for it to extend, so the combination is rejected
    // rather than silently guessing which list it means.
    if (q.acceptable !== undefined) {
      throw new Error(`query "${q.id}" has "acceptable" together with legacy "gold" — "acceptable" only extends a "required" group`);
    }
  } else {
    throw new Error(`query "${q.id}" must have "required" or (legacy) "gold"`);
  }

  if (q.acceptable !== undefined) {
    if (!Array.isArray(q.acceptable)) {
      throw new Error(`query "${q.id}" has an invalid "acceptable" (must be an array)`);
    }
    assertStringMembers(q.acceptable, `"acceptable"`);
    if (required.length !== 1) {
      throw new Error(
        `query "${q.id}" has "acceptable" but "required" has ${required.length} groups — "acceptable" is only allowed with exactly one required group (ambiguous which group it would extend otherwise)`,
      );
    }
    required = [[...required[0], ...q.acceptable]];
  }

  // The exact same entry string in two different required groups is
  // ambiguous bookkeeping (which group did a matching result satisfy?) and
  // almost always a copy-paste mistake — reject it. A path and its
  // path#symbol form in different groups are NOT duplicates: a single
  // result may legitimately satisfy both (see README).
  const seenIn = new Map();
  for (let gi = 0; gi < required.length; gi++) {
    for (const entry of required[gi]) {
      if (seenIn.has(entry) && seenIn.get(entry) !== gi) {
        throw new Error(`query "${q.id}" has "${entry}" in more than one required group (required[${seenIn.get(entry)}] and required[${gi}])`);
      }
      seenIn.set(entry, gi);
    }
  }

  let partial = [];
  if (q.partial !== undefined) {
    if (!Array.isArray(q.partial)) {
      throw new Error(`query "${q.id}" has an invalid "partial" (must be an array)`);
    }
    assertStringMembers(q.partial, `"partial"`);
    partial = q.partial.slice();
  }

  return { id: q.id, query: q.query, required, partial };
}

function validateAndNormalizeQueries(queries) {
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error("gold file must contain at least one query");
  }
  return queries.map((q, i) => normalizeQuery(q, i));
}

/**
 * Parses a gold file's raw text into `{ queries: [...] }` (normalized —
 * see `normalizeQuery`). `ext` is `.json` (one object with a top-level
 * `queries` array) or `.jsonl` (one query object per non-blank line, no
 * wrapper). Throws a clear error — never returns a partial/garbage result —
 * for malformed JSON or an invalid query shape.
 */
export function loadGold(text, ext) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("gold file is empty");

  if (ext === ".jsonl") {
    const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const raw = lines.map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        throw new Error(`invalid JSON on line ${i + 1} of gold file: ${e.message}`);
      }
    });
    return { queries: validateAndNormalizeQueries(raw) };
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
  return { queries: validateAndNormalizeQueries(parsed.queries) };
}

// ── pure scoring ──────────────────────────────────────────────────────────

/** Matches one required/partial entry (`"path"` or `"path#symbol"`) against a
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
 * Scores one query's `results` (already ranked, any length) against a
 * normalized `query` (`{ required: string[][], partial: string[] }`) at
 * `limit`. Only the top `limit` results are considered — a hit ranked below
 * `limit` is a MISS, matching what a user would actually see.
 */
export function scoreResults(results, query, limit) {
  const sliced = results.slice(0, limit);
  const groups = query.required;
  const partial = query.partial ?? [];

  const relevant = [];
  let firstRelevantRank = null;
  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    let found = null;
    for (let i = 0; i < sliced.length; i++) {
      if (group.some((entry) => matchesEntry(sliced[i], entry))) {
        found = { group: gi, rank: i + 1, provenance: sliced[i].provenance ?? null };
        break;
      }
    }
    if (found) {
      relevant.push(found);
      if (firstRelevantRank === null || found.rank < firstRelevantRank) firstRelevantRank = found.rank;
    }
  }

  const requiredGroups = groups.length;
  const requiredFound = relevant.length;
  const recall = requiredGroups > 0 ? requiredFound / requiredGroups : 0;
  const allRequired = requiredGroups > 0 && requiredFound === requiredGroups;
  const completeRank = allRequired ? Math.max(...relevant.map((r) => r.rank)) : null;
  const reciprocalRank = firstRelevantRank ? 1 / firstRelevantRank : 0;

  const hasPartialHit = partial.length > 0 && sliced.some((c) => partial.some((p) => matchesEntry(c, p)));
  let verdict;
  if (allRequired) verdict = "HIT";
  else if (requiredFound > 0 || hasPartialHit) verdict = "PARTIAL";
  else verdict = "MISS";

  return {
    requiredGroups,
    requiredFound,
    recall,
    allRequired,
    firstRelevantRank,
    completeRank,
    reciprocalRank,
    verdict,
    relevant,
  };
}

/**
 * Checks every `required`/`partial` entry across `gold.queries` (already
 * normalized — see `normalizeQuery`) against a loaded graph's nodes, without
 * running any searches. A bare path with no node at that path is
 * "FILE NOT INDEXED"; a `path#symbol` entry whose path has nodes but none of
 * them has `name === symbol` is "SYMBOL NOT INDEXED" and lists up to 3 node
 * names at that path containing the symbol case-insensitively as hints (a
 * cheap "did you mean" for a typo'd or unindexed symbol). Returns an array of
 * human-readable problem strings, each prefixed with the query id — empty
 * when every gold entry names something the graph actually indexes.
 */
export function checkGold(gold, graph) {
  const nodesByPath = new Map();
  for (const node of graph.nodes) {
    const list = nodesByPath.get(node.path);
    if (list) list.push(node);
    else nodesByPath.set(node.path, [node]);
  }

  const problems = [];
  for (let i = 0; i < gold.queries.length; i++) {
    const q = normalizeQuery(gold.queries[i], i);
    const entries = [...q.required.flat(), ...q.partial];
    for (const entry of entries) {
      const hashIdx = entry.indexOf("#");
      const path = hashIdx === -1 ? entry : entry.slice(0, hashIdx);
      const symbol = hashIdx === -1 ? null : entry.slice(hashIdx + 1);
      const nodesAtPath = nodesByPath.get(path);

      if (!nodesAtPath) {
        problems.push(`${q.id}: "${entry}" — FILE NOT INDEXED`);
        continue;
      }
      if (symbol !== null && !nodesAtPath.some((n) => n.name === symbol)) {
        const hints = nodesAtPath
          .map((n) => n.name)
          .filter((name) => typeof name === "string" && name.toLowerCase().includes(symbol.toLowerCase()))
          .slice(0, 3);
        const hintSuffix = hints.length > 0 ? ` (candidates at ${path}: ${hints.join(", ")})` : "";
        problems.push(`${q.id}: "${entry}" — SYMBOL NOT INDEXED${hintSuffix}`);
      }
    }
  }
  return problems;
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
 * Runs every query in `gold.queries` through `search` once PER `limit` —
 * `search(query, { limit, includeTests, colgrepMode, k, _ablation })` is
 * called once for every (query, limit) pair, each scored against its own
 * run's results (never a prefix slice of another limit's run, since results
 * at a shorter limit are not guaranteed to be a prefix of a longer one's).
 *
 * `search(query, opts)` must resolve to `{ results: SearchCandidate[] }` (or
 * a bare array). Injected so this never needs a real graph or ColGREP in
 * tests — the CLI `main()` below supplies the real one.
 *
 * Each `perLimit[limit]` also carries `results: [{ rank, path, name,
 * provenance }]` — the top-`limit` candidates `search` actually returned, so
 * a MISS/PARTIAL can be diagnosed (or re-scored offline) without re-running
 * the search. This is separate from `relevant` (from `scoreResults`), which
 * lists only the candidates that satisfied a required group.
 */
export async function runEval({ search, gold, limits = [5], includeTests = false, colgrepMode, k, _ablation }) {
  const perQuery = [];

  for (const rawQuery of gold.queries) {
    const q = normalizeQuery(rawQuery, perQuery.length);
    const perLimit = {};

    for (const limit of limits) {
      const opts = { limit, includeTests, colgrepMode, k, _ablation };
      const t0 = performance.now();
      const raw = await search(q.query, opts);
      const ms = performance.now() - t0;
      const candidates = Array.isArray(raw) ? raw : (raw?.results ?? []);
      const topN = candidates.slice(0, limit);

      perLimit[limit] = {
        ...scoreResults(topN, q, limit),
        results: topN.map((c, i) => ({ rank: i + 1, path: c.path, name: c.name, provenance: c.provenance ?? null })),
        outputChars: renderTopN(topN).length,
        ms,
      };
    }

    perQuery.push({ id: q.id, query: q.query, perLimit });
  }

  const totals = {};
  for (const limit of limits) {
    const scored = perQuery.map((pq) => pq.perLimit[limit]);
    const n = scored.length || 1;
    const hit = scored.filter((s) => s.verdict === "HIT").length;
    const partial = scored.filter((s) => s.verdict === "PARTIAL").length;
    const miss = scored.filter((s) => s.verdict === "MISS").length;
    totals[limit] = {
      hit,
      partial,
      miss,
      meanRecall: scored.reduce((a, s) => a + s.recall, 0) / n,
      allRequiredCount: scored.filter((s) => s.allRequired).length,
      mrr: scored.reduce((a, s) => a + s.reciprocalRank, 0) / n,
      meanMs: scored.reduce((a, s) => a + s.ms, 0) / n,
      meanOutputChars: scored.reduce((a, s) => a + s.outputChars, 0) / n,
    };
  }

  return { perQuery, totals, limits };
}

/** Named presets for `--arms`: a colgrep mode plus, for a few, an internal
 * `_ablation` combination (see `plans/2026-09-23-search-eval-metrics-plan.md`
 * Phase A). `_ablation` arms only work `--via api` — the CLI has no flag for
 * them. */
export const ARM_PRESETS = {
  off: { colgrepMode: "off" },
  hybrid: { colgrepMode: "hybrid" },
  semantic: { colgrepMode: "semantic" },
  "samefile-tier2": { colgrepMode: "hybrid", _ablation: { sameFile: "tier2" } },
  "samefile-off": { colgrepMode: "hybrid", _ablation: { sameFile: "off" } },
  "rrf-order": { colgrepMode: "hybrid", _ablation: { ordering: "rrf" } },
  "no-graphrank": { colgrepMode: "hybrid", _ablation: { graphRank: false } },
};

/** Resolves an arm name to its preset config; throws a name-identifying error
 * on an unknown arm. */
function resolveArm(name) {
  const config = ARM_PRESETS[name];
  if (!config) {
    throw new Error(`unknown arm "${name}"; expected one of ${Object.keys(ARM_PRESETS).join(", ")}`);
  }
  return config;
}

/** Runs `gold` through `search` once per named arm (see `ARM_PRESETS`),
 * reusing `runEval` for each. `k` (if given) applies to every arm. */
export async function runArms({ search, gold, limits, includeTests, arms, k }) {
  const results = [];
  for (const name of arms) {
    const config = resolveArm(name);
    const evalResult = await runEval({
      search,
      gold,
      limits,
      includeTests,
      colgrepMode: config.colgrepMode,
      k,
      _ablation: config._ablation,
    });
    results.push({ name, config, limits: evalResult.limits, perQuery: evalResult.perQuery, totals: evalResult.totals });
  }
  return { arms: results };
}

// ── rendering ───────────────────────────────────────────────────────────

function fmtRank(r) {
  return r ?? "-";
}

function renderArmMarkdown(arm) {
  const lines = [`## arm: ${arm.name}`, "", `config: \`${JSON.stringify(arm.config)}\``, ""];
  for (const limit of arm.limits) {
    lines.push(`### limit ${limit}`, "");
    lines.push(
      "| query | verdict | found/groups | first | complete | RR | provenance | chars | ms |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const pq of arm.perQuery) {
      const s = pq.perLimit[limit];
      const provenance = s.relevant.map((r) => r.provenance ?? "-").join(",") || "-";
      lines.push(
        `| ${pq.id} | ${s.verdict} | ${s.requiredFound}/${s.requiredGroups} | ${fmtRank(s.firstRelevantRank)} | ${fmtRank(s.completeRank)} | ${s.reciprocalRank.toFixed(2)} | ${provenance} | ${s.outputChars} | ${s.ms.toFixed(1)} |`,
      );
    }
    const t = arm.totals[limit];
    lines.push(
      `| **totals** | hit=${t.hit} partial=${t.partial} miss=${t.miss} | allRequired=${t.allRequiredCount} | | | mrr=${t.mrr.toFixed(2)} | | mean=${t.meanOutputChars.toFixed(0)} | mean=${t.meanMs.toFixed(1)} |`,
      "",
    );
  }
  return lines.join("\n");
}

function renderComparisonMarkdown(arms) {
  const lines = ["## arm × limit comparison", ""];
  lines.push(
    "| arm | limit | hit | partial | miss | meanRecall | allRequired | mrr | meanMs | meanChars |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const arm of arms) {
    for (const limit of arm.limits) {
      const t = arm.totals[limit];
      lines.push(
        `| ${arm.name} | ${limit} | ${t.hit} | ${t.partial} | ${t.miss} | ${t.meanRecall.toFixed(2)} | ${t.allRequiredCount} | ${t.mrr.toFixed(2)} | ${t.meanMs.toFixed(1)} | ${t.meanOutputChars.toFixed(0)} |`,
      );
    }
  }
  return lines.join("\n");
}

function renderMarkdown(armsResult) {
  const sections = armsResult.arms.map(renderArmMarkdown);
  if (armsResult.arms.length > 1) sections.push(renderComparisonMarkdown(armsResult.arms));
  return sections.join("\n\n");
}

// ── CLI (I/O only past this point) ─────────────────────────────────────────

const USAGE =
  "usage: node scripts/eval-search.mjs <gold-file> [--dir <repo>] [--limits 5,8] [--json] [--include-tests] " +
  "[--via cli|api] [--colgrep-mode hybrid|semantic|off] [--k <n>] " +
  "[--arms off,hybrid,semantic,samefile-tier2,samefile-off,rrf-order,no-graphrank] [--check-gold]";

async function main() {
  const rawArgs = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs({
      args: rawArgs,
      strict: true,
      allowPositionals: true,
      options: {
        dir: { type: "string" },
        limits: { type: "string" },
        json: { type: "boolean" },
        "include-tests": { type: "boolean" },
        via: { type: "string" },
        "colgrep-mode": { type: "string" },
        k: { type: "string" },
        arms: { type: "string" },
        "check-gold": { type: "boolean" },
      },
    });
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    process.exit(2);
  }

  const { values, positionals } = parsed;
  const goldPath = positionals[0];
  if (!goldPath) {
    console.error(USAGE);
    process.exit(2);
  }

  const dir = resolve(values.dir ?? ".");
  const limits = (values.limits ?? "5,8").split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n) && n > 0);
  const asJson = values.json === true;
  const includeTests = values["include-tests"] === true;
  const via = values.via ?? "api";
  if (via !== "cli" && via !== "api") {
    console.error(`invalid --via "${via}"; expected cli | api`);
    process.exit(2);
  }
  const colgrepModeArg = values["colgrep-mode"];
  if (colgrepModeArg !== undefined && !["hybrid", "semantic", "off"].includes(colgrepModeArg)) {
    console.error(`invalid --colgrep-mode "${colgrepModeArg}"; expected hybrid | semantic | off`);
    process.exit(2);
  }
  const colgrepMode = colgrepModeArg === "semantic" || colgrepModeArg === "off" ? colgrepModeArg : undefined;
  const kArg = values.k;
  const k = kArg !== undefined ? Number(kArg) : undefined;
  if (kArg !== undefined && !Number.isFinite(k)) {
    console.error(`invalid --k "${kArg}"; expected a number`);
    process.exit(2);
  }

  const armsArg = values.arms;
  if (armsArg !== undefined && colgrepModeArg !== undefined) {
    console.error("--arms and --colgrep-mode cannot be combined — each named arm defines its own colgrep mode");
    process.exit(2);
  }

  let armNames;
  let armConfigs;
  try {
    if (armsArg !== undefined) {
      armNames = armsArg.split(",").map((s) => s.trim()).filter(Boolean);
      if (armNames.length === 0) {
        throw new Error(`--arms "${armsArg}" resolved to zero arm names`);
      }
      armConfigs = armNames.map((name) => ({ name, config: resolveArm(name) }));
    } else {
      armNames = [colgrepModeArg ?? "hybrid"];
      armConfigs = [{ name: armNames[0], config: { colgrepMode } }];
    }
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  if (via === "cli") {
    const ablationArm = armConfigs.find((a) => a.config._ablation);
    if (ablationArm) {
      console.error(`arm "${ablationArm.name}" uses an internal ablation option that requires --via api (the CLI has no flag for it)`);
      process.exit(2);
    }
  }

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

  if (values["check-gold"] === true) {
    const loadPath = join(packageRoot, "dist", "graph", "load.js");
    if (!existsSync(loadPath)) {
      console.error("run `npm run build` first (dist/graph/load.js not found)");
      process.exit(2);
    }
    const { loadGraphCached } = await import(pathToFileURL(loadPath).href);
    const graph = loadGraphCached(join(dir, "graft"));
    if (!graph) {
      console.error("no graph found — run `graft build` first");
      process.exit(2);
    }
    const problems = checkGold(gold, graph);
    for (const problem of problems) console.error(problem);
    process.exit(problems.length > 0 ? 1 : 0);
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
          ...(opts.k !== undefined ? ["--k", String(opts.k)] : []),
        ],
        { encoding: "utf8" },
      );
      if (proc.status !== 0) {
        throw new Error(`CLI search exited with status ${proc.status}: ${proc.stderr}`);
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
      apiSearch(dir, query, {
        limit: opts.limit,
        includeTests: opts.includeTests,
        colgrepMode: opts.colgrepMode,
        k: opts.k,
        _ablation: opts._ablation,
      });
  }

  let armsResult;
  try {
    armsResult = await runArms({ search, gold, limits, includeTests, arms: armNames, k });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify(armsResult, null, 2));
  } else {
    console.log(renderMarkdown(armsResult));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
