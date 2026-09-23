/**
 * `scripts/eval-search.mjs` — pure scoring/loading/orchestration tests. No
 * real graph, no ColGREP: `runEval`/`runArms` take `search` injected, so
 * these never touch a built graph.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { scoreResults, loadGold, normalizeQuery, runEval, runArms, ARM_PRESETS, checkGold } from "../scripts/eval-search.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures", "eval-search");
const packageRoot = join(here, "..");

function fixtureNode(path, name) {
  return {
    id: `${path}#${name}`,
    path,
    span: "L1-L5",
    kind: "function",
    name,
    signature: `function ${name}()`,
    exported: true,
    origin: "ast",
    body_hash: "x",
    summary_state: "pending",
    summary: null,
    crux: null,
  };
}

/** A minimal built graph (via the package's own compiled `writeGraph`) for
 * CLI-level tests that must exercise a real `search()` call (or `--check-gold`)
 * end to end without touching this repo's own (nonexistent) graph. */
async function makeFixtureRepoWithGraph(nodes = [fixtureNode("src/auth/session.ts", "checkExpiry")]) {
  const { writeGraph } = await import(pathToFileURL(join(packageRoot, "dist", "graph", "write.js")).href);
  const root = mkdtempSync(join(tmpdir(), "eval-search-cli-fixture-"));
  const graph = { meta: { version: 1, nodeCount: nodes.length, edgeCount: 0, languages: ["ts"] }, nodes, edges: [] };
  writeGraph(graph, join(root, "graft"));
  return root;
}

function candidate(path, name, provenance = "lexical") {
  return { path, name, provenance };
}

// ── scoreResults / matching ─────────────────────────────────────────────────

test("scoreResults: HIT by bare path (single required group)", () => {
  const results = [candidate("a.ts", "foo"), candidate("src/x.ts", "bar", "both")];
  const q = normalizeQuery({ id: "q", query: "x", required: ["src/x.ts"] }, 0);
  const r = scoreResults(results, q, 5);
  assert.equal(r.verdict, "HIT");
  assert.equal(r.allRequired, true);
  assert.equal(r.firstRelevantRank, 2);
  assert.equal(r.completeRank, 2);
  assert.equal(r.reciprocalRank, 0.5);
  assert.deepEqual(r.relevant, [{ group: 0, rank: 2, provenance: "both" }]);
});

test("scoreResults: HIT by path#symbol", () => {
  const results = [candidate("src/x.ts", "otherFn"), candidate("src/x.ts", "checkExpiry", "colgrep")];
  const q = normalizeQuery({ id: "q", query: "x", required: ["src/x.ts#checkExpiry"] }, 0);
  const r = scoreResults(results, q, 5);
  assert.equal(r.verdict, "HIT");
  assert.deepEqual(r.relevant, [{ group: 0, rank: 2, provenance: "colgrep" }]);
});

test("scoreResults: PARTIAL when only a partial path appears", () => {
  const results = [candidate("src/x.ts", "checkExpiry", "graph")];
  const q = normalizeQuery({ id: "q", query: "x", required: ["src/other.ts"], partial: ["src/x.ts"] }, 0);
  const r = scoreResults(results, q, 5);
  assert.equal(r.verdict, "PARTIAL");
  assert.equal(r.requiredFound, 0);
  assert.equal(r.firstRelevantRank, null);
});

test("scoreResults: MISS when nothing matches", () => {
  const results = [candidate("src/nope.ts", "nope")];
  const q = normalizeQuery({ id: "q", query: "x", required: ["src/x.ts"] }, 0);
  const r = scoreResults(results, q, 5);
  assert.equal(r.verdict, "MISS");
  assert.equal(r.firstRelevantRank, null);
  assert.equal(r.reciprocalRank, 0);
});

test("scoreResults: a hit beyond the limit is a MISS", () => {
  const results = [candidate("a.ts", "a"), candidate("b.ts", "b"), candidate("src/x.ts", "hit")];
  const q = normalizeQuery({ id: "q", query: "x", required: ["src/x.ts"] }, 0);
  const r = scoreResults(results, q, 2);
  assert.equal(r.verdict, "MISS");
});

test("scoreResults: two required groups — both satisfied at different ranks", () => {
  const results = [
    candidate("nope.ts", "nope"),
    candidate("src/a.ts", "groupA", "lexical"),
    candidate("nope2.ts", "nope2"),
    candidate("src/b.ts", "groupB", "graph"),
  ];
  const q = normalizeQuery({ id: "q", query: "x", required: [["src/a.ts"], ["src/b.ts"]] }, 0);
  const r = scoreResults(results, q, 5);
  assert.equal(r.requiredGroups, 2);
  assert.equal(r.requiredFound, 2);
  assert.equal(r.recall, 1);
  assert.equal(r.allRequired, true);
  assert.equal(r.firstRelevantRank, 2);
  assert.equal(r.completeRank, 4);
  assert.equal(r.reciprocalRank, 0.5);
  assert.equal(r.verdict, "HIT");
});

test("scoreResults: two required groups — only one satisfied", () => {
  const results = [candidate("src/a.ts", "groupA", "lexical")];
  const q = normalizeQuery({ id: "q", query: "x", required: [["src/a.ts"], ["src/b.ts"]] }, 0);
  const r = scoreResults(results, q, 5);
  assert.equal(r.requiredFound, 1);
  assert.equal(r.recall, 0.5);
  assert.equal(r.allRequired, false);
  assert.equal(r.completeRank, null);
  assert.equal(r.verdict, "PARTIAL");
});

test("scoreResults: two required groups — none satisfied", () => {
  const results = [candidate("nope.ts", "nope")];
  const q = normalizeQuery({ id: "q", query: "x", required: [["src/a.ts"], ["src/b.ts"]] }, 0);
  const r = scoreResults(results, q, 5);
  assert.equal(r.firstRelevantRank, null);
  assert.equal(r.reciprocalRank, 0);
  assert.equal(r.verdict, "MISS");
});

// ── normalizeQuery / schema ──────────────────────────────────────────────────

test("normalizeQuery: string and array groups", () => {
  const q = normalizeQuery({ id: "q", query: "x", required: ["a.ts", ["b.ts", "c.ts"]] }, 0);
  assert.deepEqual(q.required, [["a.ts"], ["b.ts", "c.ts"]]);
  assert.deepEqual(q.partial, []);
});

test("normalizeQuery: acceptable with exactly one required group is appended to it", () => {
  const q = normalizeQuery({ id: "q", query: "x", required: ["a.ts"], acceptable: ["b.ts"] }, 0);
  assert.deepEqual(q.required, [["a.ts", "b.ts"]]);
});

test("normalizeQuery: acceptable with two required groups is an error", () => {
  assert.throws(
    () => normalizeQuery({ id: "q2", query: "x", required: ["a.ts", "b.ts"], acceptable: ["c.ts"] }, 0),
    /q2/,
  );
});

test("normalizeQuery: legacy gold becomes one required group", () => {
  const q = normalizeQuery({ id: "q", query: "x", gold: ["a.ts", "b.ts"] }, 0);
  assert.deepEqual(q.required, [["a.ts", "b.ts"]]);
});

test("normalizeQuery: gold + required together is an error", () => {
  assert.throws(
    () => normalizeQuery({ id: "q3", query: "x", gold: ["a.ts"], required: ["b.ts"] }, 0),
    /q3/,
  );
});

test("normalizeQuery: missing both gold and required is an error", () => {
  assert.throws(() => normalizeQuery({ id: "q4", query: "x" }, 0), /q4/);
});

test("normalizeQuery: an empty-string gold member is rejected", () => {
  assert.throws(
    () => normalizeQuery({ id: "q5", query: "x", required: [""] }, 0),
    /q5/,
  );
});

test("normalizeQuery: an empty-string member inside an alternatives group is rejected", () => {
  assert.throws(
    () => normalizeQuery({ id: "q6", query: "x", required: [["a.ts", ""]] }, 0),
    /q6/,
  );
});

test("normalizeQuery: a non-string member inside an alternatives group is rejected", () => {
  assert.throws(
    () => normalizeQuery({ id: "q7", query: "x", required: [["a.ts", 5]] }, 0),
    /q7/,
  );
});

test("normalizeQuery: an empty-string acceptable member is rejected", () => {
  assert.throws(
    () => normalizeQuery({ id: "q8", query: "x", required: ["a.ts"], acceptable: [""] }, 0),
    /q8/,
  );
});

test("normalizeQuery: a non-string acceptable member is rejected", () => {
  assert.throws(
    () => normalizeQuery({ id: "q9", query: "x", required: ["a.ts"], acceptable: [1] }, 0),
    /q9/,
  );
});

test("normalizeQuery: an empty-string partial member is rejected", () => {
  assert.throws(
    () => normalizeQuery({ id: "q10", query: "x", required: ["a.ts"], partial: [""] }, 0),
    /q10/,
  );
});

test("normalizeQuery: partial must be an array, not a bare string", () => {
  assert.throws(
    () => normalizeQuery({ id: "q11", query: "x", required: ["a.ts"], partial: "a.ts" }, 0),
    /q11/,
  );
});

test("normalizeQuery: acceptable together with legacy gold is an error (acceptable belongs to the required schema)", () => {
  assert.throws(
    () => normalizeQuery({ id: "q12", query: "x", gold: ["a.ts"], acceptable: ["b.ts"] }, 0),
    /q12/,
  );
});

test("normalizeQuery: the exact same entry string in two different required groups is rejected", () => {
  assert.throws(
    () => normalizeQuery({ id: "q13", query: "x", required: ["a.ts#Foo", ["a.ts#Foo", "b.ts"]] }, 0),
    /q13/,
  );
});

test("normalizeQuery: a path and its path#symbol form in different groups are NOT duplicates (may legitimately satisfy two groups)", () => {
  const q = normalizeQuery({ id: "q14", query: "x", required: ["a.ts", ["a.ts#Foo"]] }, 0);
  assert.deepEqual(q.required, [["a.ts"], ["a.ts#Foo"]]);
});

test("loadGold: parses a JSON gold file (legacy gold normalized to one required group)", () => {
  const text = readFileSync(join(fixtureDir, "sample-gold.json"), "utf8");
  const gold = loadGold(text, ".json");
  assert.equal(gold.queries.length, 2);
  assert.equal(gold.queries[0].id, "q1");
  assert.deepEqual(gold.queries[0].required, [["src/auth/session.ts#checkExpiry"]]);
});

test("loadGold: parses a JSONL gold file", () => {
  const text = readFileSync(join(fixtureDir, "sample-gold.jsonl"), "utf8");
  const gold = loadGold(text, ".jsonl");
  assert.equal(gold.queries.length, 2);
  assert.equal(gold.queries[1].id, "q2");
});

test("loadGold: throws a clear error on invalid JSON", () => {
  assert.throws(() => loadGold("{ not json", ".json"), /invalid JSON/i);
});

test("loadGold: throws when the top-level shape is wrong", () => {
  assert.throws(() => loadGold(JSON.stringify({ nope: [] }), ".json"), /queries/i);
});

test("loadGold: throws a query-identifying error for gold+required conflicts", () => {
  const text = JSON.stringify({ queries: [{ id: "bad-q", query: "x", gold: ["a.ts"], required: ["b.ts"] }] });
  assert.throws(() => loadGold(text, ".json"), /bad-q/);
});

// ── runEval: per-limit independence (P1) ────────────────────────────────────

test("runEval: each limit is its own search() call, not a prefix slice of a shared run", async () => {
  const gold = { queries: [{ id: "q1", query: "auth expiry", required: ["src/auth/session.ts#checkExpiry"] }] };
  const calls = [];
  // The limit-5 result list deliberately does NOT contain the limit-8 list as
  // a prefix — the hit is present only for limit 8, absent for limit 5 — so a
  // prefix-slicing implementation would score both limits identically (MISS)
  // while a per-limit implementation must find the limit-8 HIT.
  async function fakeSearch(query, opts) {
    calls.push({ query, limit: opts.limit });
    if (opts.limit === 8) {
      return { results: [candidate("src/auth/session.ts", "checkExpiry", "both")] };
    }
    return { results: [candidate("src/unrelated.ts", "x")] };
  }
  const evalResult = await runEval({ search: fakeSearch, gold, limits: [5, 8] });
  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map((c) => c.limit).sort(),
    [5, 8],
  );
  const pq = evalResult.perQuery[0];
  assert.equal(pq.perLimit[5].verdict, "MISS");
  assert.equal(pq.perLimit[8].verdict, "HIT");
  assert.equal(typeof pq.perLimit[5].ms, "number");
  assert.equal(typeof pq.perLimit[5].outputChars, "number");
  assert.equal(typeof pq.perLimit[8].ms, "number");
  assert.equal(typeof pq.perLimit[8].outputChars, "number");
});

test("runEval: perLimit carries the ranked results the search actually returned, for offline diagnosis", async () => {
  const gold = { queries: [{ id: "q1", query: "auth expiry", required: ["src/auth/session.ts#checkExpiry"] }] };
  async function fakeSearch(_query, opts) {
    return {
      results: [
        candidate("nope.ts", "nope", "lexical"),
        candidate("src/auth/session.ts", "checkExpiry", "both"),
      ].slice(0, opts.limit),
    };
  }
  const evalResult = await runEval({ search: fakeSearch, gold, limits: [1, 5] });
  const pq = evalResult.perQuery[0];
  assert.deepEqual(pq.perLimit[1].results, [{ rank: 1, path: "nope.ts", name: "nope", provenance: "lexical" }]);
  assert.deepEqual(pq.perLimit[5].results, [
    { rank: 1, path: "nope.ts", name: "nope", provenance: "lexical" },
    { rank: 2, path: "src/auth/session.ts", name: "checkExpiry", provenance: "both" },
  ]);
});

test("runEval: the added per-limit results flow through runArms but stay out of markdown output", async () => {
  const gold = { queries: [{ id: "q1", query: "x", required: ["a.ts"] }] };
  async function fakeSearch() {
    return { results: [candidate("a.ts", "a", "lexical")] };
  }
  const armsResult = await runArms({ search: fakeSearch, gold, limits: [5], arms: ["hybrid"] });
  assert.deepEqual(armsResult.arms[0].perQuery[0].perLimit[5].results, [
    { rank: 1, path: "a.ts", name: "a", provenance: "lexical" },
  ]);

  const repoRoot = await makeFixtureRepoWithGraph();
  const goldPath = join(fixtureDir, "sample-gold.json");
  const markdown = execFileSync(
    process.execPath,
    [join(packageRoot, "scripts", "eval-search.mjs"), goldPath, "--dir", repoRoot, "--limits", "1"],
    { stdio: "pipe" },
  ).toString();
  assert.doesNotMatch(markdown, /"rank"/);
  assert.match(markdown, /## arm: hybrid/);
});

test("runEval: totals include meanRecall, allRequiredCount, mrr, meanMs, meanOutputChars", async () => {
  const gold = {
    queries: [
      { id: "q1", query: "auth expiry", required: ["src/auth/session.ts#checkExpiry"] },
      { id: "q2", query: "http retry", required: ["src/net/client.ts"] },
    ],
  };
  const fakeResultsByQuery = {
    "auth expiry": [
      { path: "src/auth/session.ts", name: "otherFn", provenance: "lexical" },
      { path: "src/auth/session.ts", name: "checkExpiry", provenance: "both" },
    ],
    "http retry": [{ path: "src/unrelated.ts", name: "x", provenance: "lexical" }],
  };
  async function fakeSearch(query, opts) {
    return { results: (fakeResultsByQuery[query] ?? []).slice(0, opts.limit) };
  }
  const evalResult = await runEval({ search: fakeSearch, gold, limits: [1, 5] });
  assert.deepEqual(evalResult.limits, [1, 5]);
  assert.equal(evalResult.perQuery.length, 2);

  const q1 = evalResult.perQuery.find((p) => p.id === "q1");
  assert.equal(q1.perLimit[1].verdict, "MISS");
  assert.equal(q1.perLimit[5].verdict, "HIT");
  assert.equal(q1.perLimit[5].firstRelevantRank, 2);

  const q2 = evalResult.perQuery.find((p) => p.id === "q2");
  assert.equal(q2.perLimit[1].verdict, "MISS");
  assert.equal(q2.perLimit[5].verdict, "MISS");

  const t1 = evalResult.totals[1];
  assert.equal(t1.hit, 0);
  assert.equal(t1.partial, 0);
  assert.equal(t1.miss, 2);
  assert.equal(t1.meanRecall, 0);
  assert.equal(t1.allRequiredCount, 0);
  assert.equal(t1.mrr, 0);
  assert.equal(typeof t1.meanMs, "number");
  assert.equal(typeof t1.meanOutputChars, "number");

  const t5 = evalResult.totals[5];
  assert.equal(t5.hit, 1);
  assert.equal(t5.partial, 0);
  assert.equal(t5.miss, 1);
  assert.equal(t5.meanRecall, 0.5);
  assert.equal(t5.allRequiredCount, 1);
  assert.equal(t5.mrr, 0.25); // (1/2 + 0) / 2

  const json = JSON.stringify(evalResult);
  assert.ok(json.includes("\"verdict\":\"HIT\""));
});

test("runEval: forwards colgrepMode/k/_ablation through to the injected search function", async () => {
  const gold = { queries: [{ id: "q1", query: "auth expiry", required: ["src/auth/session.ts#checkExpiry"] }] };
  const seenOpts = [];
  async function fakeSearch(_query, opts) {
    seenOpts.push(opts);
    return { results: [] };
  }
  await runEval({ search: fakeSearch, gold, limits: [5], colgrepMode: "off", k: 30, _ablation: { graphRank: false } });
  assert.equal(seenOpts[0].colgrepMode, "off");
  assert.equal(seenOpts[0].k, 30);
  assert.deepEqual(seenOpts[0]._ablation, { graphRank: false });
});

// ── runArms (P4) ─────────────────────────────────────────────────────────────

test("runArms: passes each preset's config through to the injected search", async () => {
  const gold = { queries: [{ id: "q1", query: "x", required: ["a.ts"] }] };
  const seenOpts = [];
  async function fakeSearch(_query, opts) {
    seenOpts.push(opts);
    return { results: [] };
  }
  const result = await runArms({
    search: fakeSearch,
    gold,
    limits: [5],
    arms: ["hybrid", "samefile-tier2", "no-graphrank"],
    k: 42,
  });
  assert.equal(result.arms.length, 3);
  assert.equal(result.arms[0].name, "hybrid");
  assert.deepEqual(result.arms[0].config, ARM_PRESETS.hybrid);
  assert.equal(result.arms[1].name, "samefile-tier2");
  assert.deepEqual(result.arms[1].config, ARM_PRESETS["samefile-tier2"]);

  assert.equal(seenOpts[0].colgrepMode, "hybrid");
  assert.equal(seenOpts[0].k, 42);
  assert.equal(seenOpts[0]._ablation, undefined);

  assert.equal(seenOpts[1].colgrepMode, "hybrid");
  assert.deepEqual(seenOpts[1]._ablation, { sameFile: "tier2" });

  assert.equal(seenOpts[2].colgrepMode, "hybrid");
  assert.deepEqual(seenOpts[2]._ablation, { graphRank: false });
});

test("runArms: an unknown arm name is rejected", async () => {
  const gold = { queries: [{ id: "q1", query: "x", required: ["a.ts"] }] };
  async function fakeSearch() {
    return { results: [] };
  }
  await assert.rejects(
    () => runArms({ search: fakeSearch, gold, limits: [5], arms: ["not-a-real-arm"] }),
    /not-a-real-arm/,
  );
});

test("ARM_PRESETS: has the documented preset set with the right shapes", () => {
  assert.deepEqual(ARM_PRESETS.off, { colgrepMode: "off" });
  assert.deepEqual(ARM_PRESETS.hybrid, { colgrepMode: "hybrid" });
  assert.deepEqual(ARM_PRESETS.semantic, { colgrepMode: "semantic" });
  assert.deepEqual(ARM_PRESETS["samefile-tier2"], { colgrepMode: "hybrid", _ablation: { sameFile: "tier2" } });
  assert.deepEqual(ARM_PRESETS["samefile-off"], { colgrepMode: "hybrid", _ablation: { sameFile: "off" } });
  assert.deepEqual(ARM_PRESETS["rrf-order"], { colgrepMode: "hybrid", _ablation: { ordering: "rrf" } });
  assert.deepEqual(ARM_PRESETS["no-graphrank"], { colgrepMode: "hybrid", _ablation: { graphRank: false } });
});

// ── checkGold (P: gold-vs-graph validation) ─────────────────────────────────

function fakeGraph(nodes) {
  return { nodes };
}

test("checkGold: a bare path with an indexed node is fine", () => {
  const gold = { queries: [{ id: "q1", query: "x", required: ["src/a.ts"] }] };
  const graph = fakeGraph([{ path: "src/a.ts", name: "a" }]);
  assert.deepEqual(checkGold(gold, graph), []);
});

test("checkGold: a bare path with no indexed node is FILE NOT INDEXED", () => {
  const gold = { queries: [{ id: "q1", query: "x", required: ["src/missing.ts"] }] };
  const graph = fakeGraph([{ path: "src/a.ts", name: "a" }]);
  const problems = checkGold(gold, graph);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /q1/);
  assert.match(problems[0], /src\/missing\.ts/);
  assert.match(problems[0], /FILE NOT INDEXED/);
});

test("checkGold: path#symbol matching a node's name is fine", () => {
  const gold = { queries: [{ id: "q1", query: "x", required: ["src/a.ts#checkExpiry"] }] };
  const graph = fakeGraph([{ path: "src/a.ts", name: "checkExpiry" }]);
  assert.deepEqual(checkGold(gold, graph), []);
});

test("checkGold: path#symbol whose path has nodes but none matching the symbol is SYMBOL NOT INDEXED, with case-insensitive substring hints", () => {
  // The typo'd symbol "Expiry" is a case-insensitive substring of the real
  // node name "checkExpiry" — that containment is what produces the hint.
  const gold = { queries: [{ id: "q1", query: "x", required: ["src/a.ts#Expiry"] }] };
  const graph = fakeGraph([
    { path: "src/a.ts", name: "checkExpiry" },
    { path: "src/a.ts", name: "otherFn" },
  ]);
  const problems = checkGold(gold, graph);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /SYMBOL NOT INDEXED/);
  assert.match(problems[0], /checkExpiry/);
  assert.doesNotMatch(problems[0], /otherFn/);
});

test("checkGold: symbol hints are capped at 3 candidates", () => {
  const gold = { queries: [{ id: "q1", query: "x", required: ["src/a.ts#foo"] }] };
  const graph = fakeGraph([
    { path: "src/a.ts", name: "foo1" },
    { path: "src/a.ts", name: "foo2" },
    { path: "src/a.ts", name: "foo3" },
    { path: "src/a.ts", name: "foo4" },
  ]);
  const problems = checkGold(gold, graph);
  assert.equal(problems.length, 1);
  for (const name of ["foo1", "foo2", "foo3"]) assert.match(problems[0], new RegExp(name));
  assert.doesNotMatch(problems[0], /foo4/);
});

test("checkGold: checks required groups, partial entries, and the legacy gold shape, across multiple queries", () => {
  const gold = {
    queries: [
      { id: "q1", query: "x", required: [["src/a.ts"], ["src/missing.ts"]] },
      { id: "q2", query: "y", gold: ["src/b.ts"], partial: ["src/also-missing.ts"] },
    ],
  };
  const graph = fakeGraph([{ path: "src/a.ts", name: "a" }, { path: "src/b.ts", name: "b" }]);
  const problems = checkGold(gold, graph);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((p) => p.includes("q1") && p.includes("src/missing.ts")));
  assert.ok(problems.some((p) => p.includes("q2") && p.includes("src/also-missing.ts")));
});

test("checkGold: no problems returns an empty array", () => {
  const gold = { queries: [{ id: "q1", query: "x", required: ["src/a.ts#fn"] }] };
  const graph = fakeGraph([{ path: "src/a.ts", name: "fn" }]);
  assert.deepEqual(checkGold(gold, graph), []);
});

// ── CLI ──────────────────────────────────────────────────────────────────────

test("CLI: an invalid --colgrep-mode fails loudly with a usage error, exit 2, and prints no table", () => {
  const goldPath = join(fixtureDir, "sample-gold.json");
  assert.throws(
    () => {
      execFileSync(
        process.execPath,
        [join(packageRoot, "scripts", "eval-search.mjs"), goldPath, "--colgrep-mode", "sematic"],
        { stdio: "pipe" },
      );
    },
    (err) => {
      const stderr = err.stderr?.toString() ?? "";
      const stdout = err.stdout?.toString() ?? "";
      assert.match(stderr, /invalid --colgrep-mode "sematic"; expected hybrid \| semantic \| off/);
      assert.equal(err.status, 2);
      assert.equal(stdout, "", "no results table should be printed for a rejected invocation");
      return true;
    },
  );
});

test("CLI: an unknown --arms name fails loudly with a usage error, exit 2", () => {
  const goldPath = join(fixtureDir, "sample-gold.json");
  assert.throws(
    () => {
      execFileSync(
        process.execPath,
        [join(packageRoot, "scripts", "eval-search.mjs"), goldPath, "--arms", "not-a-real-arm"],
        { stdio: "pipe" },
      );
    },
    (err) => {
      const stderr = err.stderr?.toString() ?? "";
      assert.match(stderr, /not-a-real-arm/);
      assert.equal(err.status, 2);
      return true;
    },
  );
});

test("CLI: --via cli reports a non-zero CLI exit as a failure, exit 1, not empty results", () => {
  const goldPath = join(fixtureDir, "sample-gold.json");
  const emptyRepoDir = mkdtempSync(join(tmpdir(), "eval-search-no-graph-"));
  assert.throws(
    () => {
      execFileSync(
        process.execPath,
        [join(packageRoot, "scripts", "eval-search.mjs"), goldPath, "--dir", emptyRepoDir, "--via", "cli"],
        { stdio: "pipe" },
      );
    },
    (err) => {
      const stderr = err.stderr?.toString() ?? "";
      const stdout = err.stdout?.toString() ?? "";
      assert.match(stderr, /exit|status/i);
      assert.equal(err.status, 1);
      assert.equal(stdout, "", "no results table should be printed when the underlying CLI call fails");
      return true;
    },
  );
});

test("CLI: --flag=value form is accepted and never mistaken for the gold-file positional", async () => {
  const goldPath = join(fixtureDir, "sample-gold.json");
  const repoRoot = await makeFixtureRepoWithGraph();
  const out = execFileSync(
    process.execPath,
    [join(packageRoot, "scripts", "eval-search.mjs"), goldPath, `--dir=${repoRoot}`, "--limits=1", "--json"],
    { stdio: "pipe" },
  ).toString();
  const parsed = JSON.parse(out);
  assert.equal(parsed.arms[0].limits.length, 1);
  assert.equal(parsed.arms[0].limits[0], 1);
});

test("CLI: flags may appear before the gold-file positional too", async () => {
  const goldPath = join(fixtureDir, "sample-gold.json");
  const repoRoot = await makeFixtureRepoWithGraph();
  const out = execFileSync(
    process.execPath,
    [join(packageRoot, "scripts", "eval-search.mjs"), "--dir", repoRoot, "--limits", "1", "--json", goldPath],
    { stdio: "pipe" },
  ).toString();
  const parsed = JSON.parse(out);
  assert.equal(parsed.arms[0].limits[0], 1);
});

test("CLI: an unknown flag is a usage error, exit 2", () => {
  const goldPath = join(fixtureDir, "sample-gold.json");
  assert.throws(
    () => {
      execFileSync(
        process.execPath,
        [join(packageRoot, "scripts", "eval-search.mjs"), goldPath, "--not-a-real-flag"],
        { stdio: "pipe" },
      );
    },
    (err) => {
      assert.equal(err.status, 2);
      return true;
    },
  );
});

test("CLI: an invalid --via value is a usage error, exit 2", () => {
  const goldPath = join(fixtureDir, "sample-gold.json");
  assert.throws(
    () => {
      execFileSync(
        process.execPath,
        [join(packageRoot, "scripts", "eval-search.mjs"), goldPath, "--via", "sql"],
        { stdio: "pipe" },
      );
    },
    (err) => {
      const stderr = err.stderr?.toString() ?? "";
      assert.match(stderr, /--via/);
      assert.equal(err.status, 2);
      return true;
    },
  );
});

test("CLI: --arms resolving to zero names is a usage error, exit 2", () => {
  const goldPath = join(fixtureDir, "sample-gold.json");
  for (const armsValue of ["", ","]) {
    assert.throws(
      () => {
        execFileSync(
          process.execPath,
          [join(packageRoot, "scripts", "eval-search.mjs"), goldPath, "--arms", armsValue],
          { stdio: "pipe" },
        );
      },
      (err) => {
        assert.equal(err.status, 2, `--arms "${armsValue}" should be a usage error`);
        return true;
      },
    );
  }
});

test("CLI: --arms together with --colgrep-mode is a usage error, exit 2", () => {
  const goldPath = join(fixtureDir, "sample-gold.json");
  assert.throws(
    () => {
      execFileSync(
        process.execPath,
        [join(packageRoot, "scripts", "eval-search.mjs"), goldPath, "--arms", "hybrid", "--colgrep-mode", "semantic"],
        { stdio: "pipe" },
      );
    },
    (err) => {
      const stderr = err.stderr?.toString() ?? "";
      assert.match(stderr, /--arms/);
      assert.match(stderr, /--colgrep-mode/);
      assert.equal(err.status, 2);
      return true;
    },
  );
});

test("CLI: an _ablation arm with --via cli is a usage error, exit 2", () => {
  const goldPath = join(fixtureDir, "sample-gold.json");
  assert.throws(
    () => {
      execFileSync(
        process.execPath,
        [join(packageRoot, "scripts", "eval-search.mjs"), goldPath, "--arms", "no-graphrank", "--via", "cli"],
        { stdio: "pipe" },
      );
    },
    (err) => {
      const stderr = err.stderr?.toString() ?? "";
      assert.match(stderr, /--via api/);
      assert.equal(err.status, 2);
      return true;
    },
  );
});

// ── CLI --check-gold ─────────────────────────────────────────────────────────

test("CLI: --check-gold exits 0 and prints nothing when every gold entry is indexed", async () => {
  const goldPath = join(fixtureDir, "sample-gold.json");
  const repoRoot = await makeFixtureRepoWithGraph([
    fixtureNode("src/auth/session.ts", "checkExpiry"),
    fixtureNode("src/net/client.ts", "retry"),
  ]);
  const out = execFileSync(
    process.execPath,
    [join(packageRoot, "scripts", "eval-search.mjs"), goldPath, "--dir", repoRoot, "--check-gold"],
    { stdio: "pipe" },
  );
  assert.equal(out.toString(), "");
});

test("CLI: --check-gold exits 1 and prints one line per problem, running no searches", async () => {
  const goldPath = join(fixtureDir, "sample-gold.json");
  // Only q1's entry is indexed; q2's "src/net/client.ts" is not.
  const repoRoot = await makeFixtureRepoWithGraph([fixtureNode("src/auth/session.ts", "checkExpiry")]);
  assert.throws(
    () => {
      execFileSync(
        process.execPath,
        [join(packageRoot, "scripts", "eval-search.mjs"), goldPath, "--dir", repoRoot, "--check-gold"],
        { stdio: "pipe" },
      );
    },
    (err) => {
      const stderr = err.stderr?.toString() ?? "";
      const stdout = err.stdout?.toString() ?? "";
      assert.equal(err.status, 1);
      assert.match(stderr, /q2/);
      assert.match(stderr, /src\/net\/client\.ts/);
      assert.match(stderr, /FILE NOT INDEXED/);
      assert.equal(stdout, "", "no results table should be printed for --check-gold");
      return true;
    },
  );
});

test("CLI: --check-gold with no graph on disk fails loudly instead of silently searching", () => {
  const goldPath = join(fixtureDir, "sample-gold.json");
  const emptyRepoDir = mkdtempSync(join(tmpdir(), "eval-search-no-graph-"));
  assert.throws(
    () => {
      execFileSync(
        process.execPath,
        [join(packageRoot, "scripts", "eval-search.mjs"), goldPath, "--dir", emptyRepoDir, "--check-gold"],
        { stdio: "pipe" },
      );
    },
    (err) => {
      const stderr = err.stderr?.toString() ?? "";
      assert.match(stderr, /no graph found/);
      assert.equal(err.status, 2);
      return true;
    },
  );
});
