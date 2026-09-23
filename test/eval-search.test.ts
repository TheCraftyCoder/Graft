/**
 * `scripts/eval-search.mjs` — pure scoring/loading/orchestration tests. No
 * real graph, no ColGREP: `runEval` takes its `search` function injected, so
 * these never touch a built graph.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { scoreResults, loadGold, runEval } from "../scripts/eval-search.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "fixtures", "eval-search");
const packageRoot = join(here, "..");

function candidate(path, name, provenance = "lexical") {
  return { path, name, provenance };
}

test("scoreResults: HIT by bare path", () => {
  const results = [candidate("a.ts", "foo"), candidate("src/x.ts", "bar", "both")];
  const r = scoreResults(results, { gold: ["src/x.ts"] }, 5);
  assert.deepEqual(r, { verdict: "HIT", rank: 2, provenance: "both" });
});

test("scoreResults: HIT by path#symbol", () => {
  const results = [candidate("src/x.ts", "otherFn"), candidate("src/x.ts", "checkExpiry", "colgrep")];
  const r = scoreResults(results, { gold: ["src/x.ts#checkExpiry"] }, 5);
  assert.deepEqual(r, { verdict: "HIT", rank: 2, provenance: "colgrep" });
});

test("scoreResults: PARTIAL when only a partial path appears", () => {
  const results = [candidate("src/x.ts", "checkExpiry", "graph")];
  const r = scoreResults(results, { gold: ["src/other.ts"], partial: ["src/x.ts"] }, 5);
  assert.deepEqual(r, { verdict: "PARTIAL", rank: 1, provenance: "graph" });
});

test("scoreResults: MISS when nothing matches", () => {
  const results = [candidate("src/nope.ts", "nope")];
  const r = scoreResults(results, { gold: ["src/x.ts"] }, 5);
  assert.deepEqual(r, { verdict: "MISS", rank: null, provenance: null });
});

test("scoreResults: a gold hit beyond the limit is a MISS", () => {
  const results = [
    candidate("a.ts", "a"),
    candidate("b.ts", "b"),
    candidate("src/x.ts", "hit"), // rank 3
  ];
  const r = scoreResults(results, { gold: ["src/x.ts"] }, 2);
  assert.deepEqual(r, { verdict: "MISS", rank: null, provenance: null });
});

test("loadGold: parses a JSON gold file", () => {
  const text = readFileSync(join(fixtureDir, "sample-gold.json"), "utf8");
  const gold = loadGold(text, ".json");
  assert.equal(gold.queries.length, 2);
  assert.equal(gold.queries[0].id, "q1");
  assert.deepEqual(gold.queries[0].gold, ["src/auth/session.ts#checkExpiry"]);
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

test("runEval: end-to-end against an injected fake search function", async () => {
  const gold = {
    queries: [
      { id: "q1", query: "auth expiry", gold: ["src/auth/session.ts#checkExpiry"] },
      { id: "q2", query: "http retry", gold: ["src/net/client.ts"] },
    ],
  };
  const fakeResultsByQuery = {
    "auth expiry": [
      { path: "src/auth/session.ts", name: "otherFn", provenance: "lexical" },
      { path: "src/auth/session.ts", name: "checkExpiry", provenance: "both" },
    ],
    "http retry": [{ path: "src/unrelated.ts", name: "x", provenance: "lexical" }],
  };
  async function fakeSearch(query) {
    return { results: fakeResultsByQuery[query] ?? [] };
  }
  const evalResult = await runEval({ search: fakeSearch, gold, limits: [1, 5] });
  assert.deepEqual(evalResult.limits, [1, 5]);
  assert.equal(evalResult.perQuery.length, 2);

  const q1 = evalResult.perQuery.find((p) => p.id === "q1");
  assert.equal(q1.perLimit[1].verdict, "MISS"); // rank 2, beyond limit 1
  assert.equal(q1.perLimit[5].verdict, "HIT");
  assert.equal(q1.perLimit[5].rank, 2);
  assert.equal(typeof q1.ms, "number");
  assert.equal(typeof q1.outputChars, "number");

  const q2 = evalResult.perQuery.find((p) => p.id === "q2");
  assert.equal(q2.perLimit[1].verdict, "MISS");
  assert.equal(q2.perLimit[5].verdict, "MISS");

  assert.deepEqual(evalResult.totals[1], { hit: 0, partial: 0, miss: 2 });
  assert.deepEqual(evalResult.totals[5], { hit: 1, partial: 0, miss: 1 });

  const json = JSON.stringify(evalResult);
  assert.ok(json.includes("\"verdict\":\"HIT\""));
});

test("runEval: forwards colgrepMode through to the injected search function", async () => {
  const gold = { queries: [{ id: "q1", query: "auth expiry", gold: ["src/auth/session.ts#checkExpiry"] }] };
  const seenOpts: Record<string, unknown>[] = [];
  async function fakeSearch(_query: string, opts: Record<string, unknown>) {
    seenOpts.push(opts);
    return { results: [] };
  }
  await runEval({ search: fakeSearch, gold, limits: [5], colgrepMode: "off" });
  assert.equal(seenOpts[0].colgrepMode, "off");
});

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
