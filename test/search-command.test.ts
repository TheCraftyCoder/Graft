/**
 * `src/search/search.ts` — the `graft search` orchestrator: fuses `ask` with
 * ColGREP semantic hits. Exercises the fallback path (colgrep absent), the
 * fused path (a fake colgrep on PATH against a small on-disk graph), and the
 * `--json`-shaped result contract.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { search } from "../src/search/search.js";
import { writeGraph } from "../src/graph/write.js";
import { buildGraph } from "../src/graph/build.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

function node(partial: Partial<NodeV1> & Pick<NodeV1, "id" | "path" | "span" | "kind" | "name">): NodeV1 {
  return {
    signature: null,
    exported: false,
    origin: "ast",
    body_hash: "x",
    summary_state: "pending",
    summary: null,
    crux: null,
    ...partial,
  };
}

/** A small fixture repo with a built (Tier-1-only) graph: three symbols, one
 * per file, so `ask` and a fake colgrep hit can be steered independently. */
function makeFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "graft-search-cmd-"));
  const graph: GraphV1 = {
    meta: { version: 1, nodeCount: 3, edgeCount: 0, languages: ["ts"] },
    nodes: [
      node({
        id: "src/alpha.ts#provisionResource",
        path: "src/alpha.ts",
        span: "L1-L10",
        kind: "function",
        name: "provisionResource",
        signature: "function provisionResource()",
      }),
      node({
        id: "src/beta.ts#renderDashboardOverlay",
        path: "src/beta.ts",
        span: "L1-L10",
        kind: "function",
        name: "renderDashboardOverlay",
        signature: "function renderDashboardOverlay()",
      }),
      node({
        id: "src/gamma.ts#computeUsageRate",
        path: "src/gamma.ts",
        span: "L1-L10",
        kind: "function",
        name: "computeUsageRate",
        signature: "function computeUsageRate()",
      }),
    ],
    edges: [],
  };
  writeGraph(graph, join(root, "graft"));
  return root;
}

/** Fake `colgrep`: a Node fixture script, spawned directly via
 * `GRAFT_COLGREP_BIN=process.execPath` / `GRAFT_COLGREP_ARGS_PREFIX=[fixturePath]`
 * (see `colgrep.ts`'s env override) — this is cross-platform (no `.cmd`
 * shim on Windows / `#!/bin/sh` shim elsewhere needed) since it never
 * relies on PATH resolution at all. Its behaviour is driven by env vars so
 * one fixture script serves every scenario. */
function makeFakeColgrepFixture(): string {
  const tmpRoot = mkdtempSync(join(tmpdir(), "graft-search-cmd-bin-"));
  const fixturePath = join(tmpRoot, "fixture.mjs");
  writeFileSync(
    fixturePath,
    `
import { writeFileSync } from "node:fs";
const mode = process.env.COLGREP_FIXTURE_MODE || "hits";
const delayMs = parseInt(process.env.COLGREP_FIXTURE_DELAY_MS || "0", 10);
function respond() {
  if (process.argv.includes("--version")) {
    process.stdout.write("colgrep-fixture 9.9.9\\n");
    process.exit(0);
  }
  const dumpPath = process.env.COLGREP_ARGV_DUMP;
  if (dumpPath) writeFileSync(dumpPath, JSON.stringify(process.argv.slice(2)));
  process.stdout.write(process.env.COLGREP_FIXTURE_JSON || "[]");
  process.exit(0);
}
if (delayMs > 0) {
  setTimeout(respond, delayMs);
} else {
  respond();
}
`,
  );
  return fixturePath;
}

/** Builds the `env` override `search()` forwards to `runColgrep`, routing it
 * at the fake fixture via `GRAFT_COLGREP_BIN`/`GRAFT_COLGREP_ARGS_PREFIX`
 * instead of mutating the real `process.env.PATH`. `extra` carries the
 * fixture's own `COLGREP_FIXTURE_*`/`COLGREP_ARGV_DUMP` controls. */
function fixtureEnv(fixturePath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GRAFT_COLGREP_BIN: process.execPath,
    GRAFT_COLGREP_ARGS_PREFIX: JSON.stringify([fixturePath]),
    ...extra,
  };
}

/** Env that can never resolve `colgrep` on PATH and carries no
 * `GRAFT_COLGREP_BIN` override — independent of whatever happens to be
 * installed on the dev box, same trick as `test/search-colgrep.test.ts`'s
 * `missingEnv`. */
function unresolvableEnv(): NodeJS.ProcessEnv {
  const emptyDir = mkdtempSync(join(tmpdir(), "graft-search-cmd-empty-"));
  const env = { ...process.env, PATH: emptyDir };
  delete env.GRAFT_COLGREP_BIN;
  delete env.GRAFT_COLGREP_ARGS_PREFIX;
  return env;
}

test("search: colgrep absent -> ask-only results, note, semanticUsed false", async () => {
  const root = makeFixtureRepo();
  const result = await search(root, "provisionResource", { limit: 5, env: unresolvableEnv() });

  assert.equal(result.semanticUsed, false);
  assert.equal(
    result.note,
    "colgrep unavailable (not found on PATH or failed); showing lexical/graph results",
  );
  assert.ok(result.results.length > 0, "ask should still find the lexical match");
  assert.ok(
    result.results.every((r) => r.provenance !== "colgrep" && r.provenance !== "both"),
    "no result should claim semantic provenance when colgrep never ran",
  );
});

test("search: fused path — semantic-only hit tagged 'semantic', shared hit tagged 'both'", async () => {
  const root = makeFixtureRepo();
  const fixturePath = makeFakeColgrepFixture();

  // beta: colgrep-only (ask's query below shares no token with "beta"'s name).
  // gamma: BOTH ask (query names it exactly) and colgrep hit it.
  const hitsJson = JSON.stringify([
    {
      unit: {
        name: "renderDashboardOverlay",
        file: join(root, "src", "beta.ts"),
        line: 3,
        end_line: 5,
        unit_type: "function",
        signature: "function renderDashboardOverlay()",
      },
      score: 0.9,
    },
    {
      unit: {
        name: "computeUsageRate",
        file: join(root, "src", "gamma.ts"),
        line: 3,
        end_line: 5,
        unit_type: "function",
        signature: "function computeUsageRate()",
      },
      score: 0.8,
    },
  ]);

  const result = await search(root, "computeUsageRate", {
    limit: 10,
    env: fixtureEnv(fixturePath, { COLGREP_FIXTURE_JSON: hitsJson }),
  });

  assert.equal(result.semanticUsed, true);
  assert.equal(result.note, undefined);

  const beta = result.results.find((r) => r.path === "src/beta.ts");
  assert.ok(beta, "beta should appear from the semantic-only hit");
  assert.equal(beta!.provenance, "colgrep");

  const gamma = result.results.find((r) => r.path === "src/gamma.ts");
  assert.ok(gamma, "gamma should appear, matched by both ask and colgrep");
  assert.equal(gamma!.provenance, "both");
});

test("search: _ablation.graphRank reaches the internal ask() call and changes observable ordering", async () => {
  // A real built graph (not the static writeGraph fixture above) with a
  // same-word lexical collision between a graph-connected symbol
  // (`fooHandler`, wired to two helpers) and an isolated one (`fooWidget`) —
  // the same fixture shape `test/graphrank.test.ts` uses to prove `ask`'s
  // own graphRank option. ColGREP is routed to `unresolvableEnv()` so
  // `search()`'s result order here is exactly `ask`'s own order (tier 2
  // alternation with an empty semantic list), making the ablation's effect
  // on `ask` directly observable through `search()`.
  const root = mkdtempSync(join(tmpdir(), "graft-search-cmd-graphrank-"));
  writeFileSync(
    join(root, "connected.ts"),
    `export function fooHandler() {\n  helperAlpha();\n  helperBeta();\n}\n` +
      `export function helperAlpha() { return 1; }\n` +
      `export function helperBeta() { return 2; }\n`,
  );
  writeFileSync(join(root, "isolated.ts"), `export function fooWidget() { return 0; }\n`);
  await buildGraph(root);

  const env = unresolvableEnv();
  const namesOf = async (ablation?: { graphRank: boolean }) => {
    const result = await search(root, "foo", { limit: 10, env, ...(ablation ? { _ablation: ablation } : {}) });
    return result.results.map((r) => r.name);
  };

  const defaultOrder = await namesOf();
  const graphRankOnExplicit = await namesOf({ graphRank: true });
  const graphRankOff = await namesOf({ graphRank: false });

  assert.deepEqual(
    graphRankOnExplicit,
    defaultOrder,
    "_ablation: { graphRank: true } reproduces the default (omitted _ablation) order exactly",
  );

  const iHandlerDefault = defaultOrder.indexOf("fooHandler");
  const iWidgetDefault = defaultOrder.indexOf("fooWidget");
  assert.ok(iHandlerDefault >= 0 && iWidgetDefault >= 0, "both same-word hits present by default");
  assert.ok(
    iHandlerDefault < iWidgetDefault,
    "graphRank on (default) ranks the graph-connected hit above the isolated one",
  );

  const iHandlerOff = graphRankOff.indexOf("fooHandler");
  const iWidgetOff = graphRankOff.indexOf("fooWidget");
  assert.ok(iHandlerOff >= 0 && iWidgetOff >= 0, "both same-word hits present with graphRank off too");
  assert.ok(
    iHandlerOff >= iWidgetOff,
    "_ablation: { graphRank: false } removes the connectivity advantage, matching pure lexical order",
  );
});

test("search: a concept hit whose first source is a test file maps to its first non-test source instead", async () => {
  const root = makeFixtureRepo();
  mkdirSync(join(root, "graft"), { recursive: true });
  writeFileSync(
    join(root, "graft", "widget-concept.md"),
    `---\nslug: widget-concept\nname: zzzconceptmatch\nsources:\n  - path: foo_test.go\n  - path: foo.go\n---\n` +
      `zzzconceptmatch behavior overview.\n`,
  );

  const result = await search(root, "zzzconceptmatch", { limit: 5, env: unresolvableEnv() });
  const hit = result.results.find((r) => r.name === "zzzconceptmatch");
  assert.ok(hit, "the concept hit should still surface");
  assert.equal(hit!.path, "foo.go", "should skip the test-path source and use the next one");
});

test("search: a concept hit whose every source is a test file is dropped (unless includeTests)", async () => {
  const root = makeFixtureRepo();
  mkdirSync(join(root, "graft"), { recursive: true });
  writeFileSync(
    join(root, "graft", "all-test-concept.md"),
    `---\nslug: all-test-concept\nname: zzzalltestconcept\nsources:\n  - path: foo_test.go\n  - path: bar.test.ts\n---\n` +
      `zzzalltestconcept behavior overview.\n`,
  );

  const dropped = await search(root, "zzzalltestconcept", { limit: 5, env: unresolvableEnv() });
  assert.equal(
    dropped.results.find((r) => r.name === "zzzalltestconcept"),
    undefined,
    "a concept with only test sources should be dropped by default",
  );

  const included = await search(root, "zzzalltestconcept", {
    limit: 5,
    includeTests: true,
    env: unresolvableEnv(),
  });
  assert.ok(
    included.results.find((r) => r.name === "zzzalltestconcept"),
    "includeTests should surface it, using the first source as before",
  );
});

test("search: over-fetch fix — a low-rank ask match doesn't get artificially inflated by a colgrep hit into outranking real matches", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-search-cmd-overfetch-"));
  const strongNodes: NodeV1[] = [];
  // 20 strong matches (not 10) so the weak node's ask rank (21st) falls past
  // P2.3's wider `ask` fetch floor (`Math.max(16, limit * 2)`) — it must stay
  // OUT of the ask list entirely for this to still test the RRF-inflation
  // guard rather than genuine both-retriever agreement (which P2.3 now
  // legitimately promotes to tier 1).
  for (let i = 0; i < 20; i++) {
    strongNodes.push(
      node({
        id: `src/strong${i}.ts#zzzstrongmatch`,
        path: `src/strong${i}.ts`,
        span: "L1-L5",
        kind: "function",
        name: "zzzstrongmatch",
        signature: "function zzzstrongmatch()",
      }),
    );
  }
  const weakNode = node({
    id: "src/weak.ts#unrelatedThing",
    path: "src/weak.ts",
    span: "L1-L5",
    kind: "function",
    name: "unrelatedThing",
    signature: "function unrelatedThing() { /* zzzstrongmatch mentioned once */ }",
  });
  const graph: GraphV1 = {
    meta: { version: 1, nodeCount: strongNodes.length + 1, edgeCount: 0, languages: ["ts"] },
    nodes: [...strongNodes, weakNode],
    edges: [],
  };
  writeGraph(graph, join(root, "graft"));

  const fixturePath = makeFakeColgrepFixture();
  // Two decoy hits ranked above the weak node's own colgrep hit, so the weak
  // node's semantic-only rank (3rd) scores well below any top ask-ranked
  // strong node — it should no longer be artificially boosted into "both".
  const hitsJson = JSON.stringify([
    { unit: { name: "decoy1", file: join(root, "decoy1.ts"), line: 1, end_line: 2, unit_type: "raw_code", signature: null }, score: 0.99 },
    { unit: { name: "decoy2", file: join(root, "decoy2.ts"), line: 1, end_line: 2, unit_type: "raw_code", signature: null }, score: 0.98 },
    { unit: { name: "unrelatedThing", file: join(root, "src", "weak.ts"), line: 1, end_line: 5, unit_type: "function", signature: weakNode.signature }, score: 0.5 },
  ]);

  const result = await search(root, "zzzstrongmatch", {
    limit: 3,
    env: fixtureEnv(fixturePath, { COLGREP_FIXTURE_JSON: hitsJson }),
  });
  const weak = result.results.find((r) => r.path === "src/weak.ts");
  if (weak) {
    assert.notEqual(weak.provenance, "both", "the weak node's colgrep hit alone shouldn't be inflated into 'both'");
  }
  assert.ok(
    result.results[0] && result.results[0].path !== "src/weak.ts",
    "a genuinely strong lexical match should rank first, not the artificially-boosted weak one",
  );
});

test("search: a slow-but-successful colgrep run past slowSemanticMs sets a refresh note instead of staying silent", async () => {
  const root = makeFixtureRepo();
  const fixturePath = makeFakeColgrepFixture();

  const result = await search(root, "provisionResource", {
    limit: 5,
    slowSemanticMs: 100,
    env: fixtureEnv(fixturePath, { COLGREP_FIXTURE_JSON: "[]", COLGREP_FIXTURE_DELAY_MS: "300" }),
  });
  assert.equal(result.semanticUsed, true);
  assert.match(result.note ?? "", /^colgrep refreshed its index \(\d+(\.\d+)? s\); repeat queries are fast$/);
});

test("search: a fast colgrep run under slowSemanticMs leaves note undefined", async () => {
  const root = makeFixtureRepo();
  const fixturePath = makeFakeColgrepFixture();

  const result = await search(root, "provisionResource", {
    limit: 5,
    env: fixtureEnv(fixturePath, { COLGREP_FIXTURE_JSON: "[]" }),
  });
  assert.equal(result.semanticUsed, true);
  assert.equal(result.note, undefined);
});

test("search: the ask fetch window is >=16 even at limit:5, so a rank-16 ask/colgrep agreement still fuses to 'both'", async () => {
  // `ask()` has no injection seam (plain ESM import, no mock.module in this
  // suite's node runner), so this proves the fetch window the way it's
  // observable from `search()`'s own contract: 16 nodes tied on lexical
  // score sort strictly alphabetically (ask.ts:1080 breaks score ties by
  // `a.title.localeCompare(b.title)`), so "widgetHandler16" always lands at
  // ask rank 16. A colgrep hit on that same node can only become `both`
  // (tier 1, ranked ahead of everything else) if `ask` was actually fetched
  // to at least 16 — at the OLD `Math.max(10, limit * 2)` window (10, for
  // `limit: 5`), rank 16 would never reach fusion and this hit would stay
  // `semantic`-only instead.
  const root = mkdtempSync(join(tmpdir(), "graft-search-cmd-fetch16-"));
  const nodes: NodeV1[] = [];
  for (let i = 1; i <= 16; i++) {
    const n = String(i).padStart(2, "0");
    nodes.push(
      node({
        id: `src/widget${n}.ts#widgetHandler${n}`,
        path: `src/widget${n}.ts`,
        span: "L1-L10",
        kind: "function",
        name: `widgetHandler${n}`,
        signature: `function widgetHandler${n}()`,
      }),
    );
  }
  const graph: GraphV1 = {
    meta: { version: 1, nodeCount: nodes.length, edgeCount: 0, languages: ["ts"] },
    nodes,
    edges: [],
  };
  writeGraph(graph, join(root, "graft"));

  const fixturePath = makeFakeColgrepFixture();
  const hitsJson = JSON.stringify([
    {
      unit: {
        name: "widgetHandler16",
        file: join(root, "src", "widget16.ts"),
        line: 3,
        end_line: 5,
        unit_type: "function",
        signature: "function widgetHandler16()",
      },
      score: 0.9,
    },
  ]);

  const result = await search(root, "widgetHandler", {
    limit: 5,
    env: fixtureEnv(fixturePath, { COLGREP_FIXTURE_JSON: hitsJson }),
  });
  const hit16 = result.results.find((r) => r.path === "src/widget16.ts");
  assert.ok(hit16, "the rank-16 ask hit must have entered fusion for 'both' to be possible at all");
  assert.equal(hit16!.provenance, "both", "ask rank 16 agreeing with colgrep must fuse to 'both', proving the fetch window was >=16");
  assert.equal(result.results[0]!.path, "src/widget16.ts", "tier-1 'both' outranks every ask-only/semantic-only tier-2 candidate");
});

test("search: --json shape includes results/note/semanticUsed/timingsMs", async () => {
  const root = makeFixtureRepo();
  const result = await search(root, "provisionResource", { limit: 5, json: true, env: unresolvableEnv() });

  assert.ok(Array.isArray(result.results));
  assert.equal(typeof result.semanticUsed, "boolean");
  assert.ok(result.timingsMs);
  assert.equal(typeof result.timingsMs.ask, "number");
  assert.equal(typeof result.timingsMs.semantic, "number");
  assert.equal(typeof result.timingsMs.wall, "number");
  assert.equal(typeof result.note, "string");
});

test("search: timingsMs.semantic is derived as wall - ask (the parallel wall time not attributable to ask)", async () => {
  const root = makeFixtureRepo();
  const result = await search(root, "provisionResource", { limit: 5, env: unresolvableEnv() });
  assert.equal(result.timingsMs.semantic, result.timingsMs.wall - result.timingsMs.ask);
});

test("search: contextDir option loads the graph from a non-default context dir, matching `ask`'s own override", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-search-cmd-ctxdir-"));
  const graph: GraphV1 = {
    meta: { version: 1, nodeCount: 1, edgeCount: 0, languages: ["ts"] },
    nodes: [
      node({
        id: "src/custom.ts#provisionResource",
        path: "src/custom.ts",
        span: "L1-L10",
        kind: "function",
        name: "provisionResource",
        signature: "function provisionResource()",
      }),
    ],
    edges: [],
  };
  // Graph lives in `<root>/customgraph`, NOT the default `<root>/graft`.
  writeGraph(graph, join(root, "customgraph"));

  await assert.rejects(
    () => search(root, "provisionResource", { limit: 5, env: unresolvableEnv() }),
    /no graph found/,
    "without contextDir, search must not silently answer empty from a graph that lives outside the default dir — it must fail loudly instead",
  );

  const withOverride = await search(root, "provisionResource", {
    limit: 5,
    contextDir: join(root, "customgraph"),
    env: unresolvableEnv(),
  });
  assert.ok(
    withOverride.results.some((r) => r.path === "src/custom.ts"),
    "contextDir should route search (and its `ask` call) to the custom graph dir",
  );
});

/** Builds the env override that routes ColGREP to the "echo" fixture mode,
 * which dumps its own argv to `dumpPath` instead of answering with hits —
 * see `makeFakeColgrepFixture`. */
function argvCaptureEnv(fixturePath: string): { env: NodeJS.ProcessEnv; dumpPath: string } {
  const dumpPath = join(mkdtempSync(join(tmpdir(), "graft-search-cmd-argvdump-")), "argv.json");
  const env = fixtureEnv(fixturePath, { COLGREP_FIXTURE_MODE: "echo", COLGREP_ARGV_DUMP: dumpPath });
  return { env, dumpPath };
}

test("search: `--in` scopes ColGREP itself — targetPath is the `in` prefix resolved under root, not the whole repo", async () => {
  const root = makeFixtureRepo();
  const { env, dumpPath } = argvCaptureEnv(makeFakeColgrepFixture());

  await search(root, "provisionResource", { limit: 5, in: "src", env });
  const argv = JSON.parse(readFileSync(dumpPath, "utf8")) as string[];

  assert.equal(argv[argv.length - 1], resolve(root, "src"), "the final positional arg should be `in` resolved under root");
});

test("search: without `in`, ColGREP's targetPath is left at its own default (whole repo)", async () => {
  const root = makeFixtureRepo();
  const { env, dumpPath } = argvCaptureEnv(makeFakeColgrepFixture());

  await search(root, "provisionResource", { limit: 5, env });
  const argv = JSON.parse(readFileSync(dumpPath, "utf8")) as string[];

  assert.equal(argv[argv.length - 1], ".", "no `in` means colgrep's own default target (repo root)");
});

test("search: requests k:15 from ColGREP always, and passes generic test exclusions itself when includeTests is false", async () => {
  const root = makeFixtureRepo();
  const { env, dumpPath } = argvCaptureEnv(makeFakeColgrepFixture());

  await search(root, "provisionResource", { limit: 5, env });
  const argv = JSON.parse(readFileSync(dumpPath, "utf8")) as string[];

  const kIdx = argv.indexOf("-k");
  assert.ok(kIdx !== -1, "-k flag should be present");
  assert.equal(argv[kIdx + 1], "15", "the k=25 over-fetch is gone now that ColGREP excludes test paths itself");
  assert.ok(argv.includes("--exclude-dir=test"), "generic test dirs are passed to ColGREP itself");
  assert.ok(argv.includes("--exclude-dir=__mocks__"));
  assert.ok(argv.includes("--exclude=*.test.*"), "generic test globs are passed to ColGREP itself");
  assert.ok(argv.includes("--exclude=*_test.go"));
});

test("search: requests k:15 from ColGREP and omits every exclusion when includeTests is true", async () => {
  const root = makeFixtureRepo();
  const { env, dumpPath } = argvCaptureEnv(makeFakeColgrepFixture());

  await search(root, "provisionResource", { limit: 5, includeTests: true, env });
  const argv = JSON.parse(readFileSync(dumpPath, "utf8")) as string[];

  const kIdx = argv.indexOf("-k");
  assert.ok(kIdx !== -1, "-k flag should be present");
  assert.equal(argv[kIdx + 1], "15");
  assert.ok(!argv.some((a) => a.startsWith("--exclude")), "includeTests means no exclusions of any kind");
});

test("search: colgrepMode 'semantic' adds --semantic-only to the ColGREP call", async () => {
  const root = makeFixtureRepo();
  const { env, dumpPath } = argvCaptureEnv(makeFakeColgrepFixture());

  await search(root, "provisionResource", { limit: 5, colgrepMode: "semantic", env });
  const argv = JSON.parse(readFileSync(dumpPath, "utf8")) as string[];
  assert.ok(argv.includes("--semantic-only"));
});

test("search: colgrepMode 'hybrid' (default) never adds --semantic-only", async () => {
  const root = makeFixtureRepo();
  const { env, dumpPath } = argvCaptureEnv(makeFakeColgrepFixture());

  await search(root, "provisionResource", { limit: 5, env });
  const argv = JSON.parse(readFileSync(dumpPath, "utf8")) as string[];
  assert.equal(argv.includes("--semantic-only"), false);
});

test("search: colgrepMode 'off' never spawns ColGREP at all — ask-only, semanticUsed false, a 'disabled' note", async () => {
  const root = makeFixtureRepo();
  const { env, dumpPath } = argvCaptureEnv(makeFakeColgrepFixture());

  const result = await search(root, "provisionResource", { limit: 5, colgrepMode: "off", env });
  assert.equal(result.semanticUsed, false);
  assert.match(result.note ?? "", /colgrep disabled/);
  assert.ok(result.results.length > 0, "ask should still find the lexical match");
  assert.ok(
    result.results.every((r) => r.provenance !== "colgrep" && r.provenance !== "both"),
    "no result should claim colgrep provenance when colgrepMode is off",
  );
  assert.equal(existsSync(dumpPath), false, "the ColGREP subprocess must never run at all when colgrepMode is off");
});

test("search: `--in ..` is rejected before ColGREP ever runs", async () => {
  const root = makeFixtureRepo();
  const { env, dumpPath } = argvCaptureEnv(makeFakeColgrepFixture());

  await assert.rejects(
    () => search(root, "provisionResource", { limit: 5, in: "..", env }),
    /--in/,
  );
  assert.equal(existsSync(dumpPath), false, "ColGREP must never be spawned for a rejected `--in`");
});

test("search: `--in ../outside` is rejected before ColGREP ever runs", async () => {
  const root = makeFixtureRepo();
  const { env, dumpPath } = argvCaptureEnv(makeFakeColgrepFixture());

  await assert.rejects(
    () => search(root, "provisionResource", { limit: 5, in: "../outside", env }),
    /--in/,
  );
  assert.equal(existsSync(dumpPath), false);
});

test("search: an absolute `--in` path is rejected before ColGREP ever runs", async () => {
  const root = makeFixtureRepo();
  const { env, dumpPath } = argvCaptureEnv(makeFakeColgrepFixture());

  // `root` itself is absolute, and would otherwise resolve INSIDE the repo —
  // absolute paths are rejected outright, independent of where they resolve.
  await assert.rejects(
    () => search(root, "provisionResource", { limit: 5, in: root, env }),
    /--in/,
  );
  assert.equal(existsSync(dumpPath), false);
});

test("search: `--in ..generated` (a real indexed directory, not a `..` escape) is accepted", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-search-cmd-dotdotdir-"));
  mkdirSync(join(root, "..generated"), { recursive: true });
  const graph: GraphV1 = {
    meta: { version: 1, nodeCount: 1, edgeCount: 0, languages: ["ts"] },
    nodes: [
      node({
        id: "..generated/thing.ts#doStuff",
        path: "..generated/thing.ts",
        span: "L1-L10",
        kind: "function",
        name: "doStuff",
        signature: "function doStuff()",
      }),
    ],
    edges: [],
  };
  writeGraph(graph, join(root, "graft"));

  const result = await search(root, "doStuff", { limit: 5, in: "..generated", env: unresolvableEnv() });
  assert.ok(
    result.results.some((r) => r.path === "..generated/thing.ts"),
    "a directory literally named '..generated' must not be rejected as a parent-traversal escape",
  );
});

test("search: no graph found at all -> a clear thrown Error before ColGREP ever spawns", async () => {
  const root = mkdtempSync(join(tmpdir(), "graft-search-cmd-nograph-"));
  const { env, dumpPath } = argvCaptureEnv(makeFakeColgrepFixture());

  await assert.rejects(
    () => search(root, "anything", { limit: 5, env }),
    /no graph found — run `graft build` first/,
  );
  assert.equal(existsSync(dumpPath), false, "ColGREP must never be spawned when there is no graph to map its hits onto");
});

test("search: opts.k NaN is rejected before any ColGREP spawn or graph work", async () => {
  const root = makeFixtureRepo();
  const { env, dumpPath } = argvCaptureEnv(makeFakeColgrepFixture());
  await assert.rejects(
    () => search(root, "provisionResource", { limit: 5, k: NaN, env }),
    /invalid k "NaN": expected a finite number >= 0/,
  );
  assert.equal(existsSync(dumpPath), false, "ColGREP must never be spawned for a rejected k");
});

test("search: opts.k negative is rejected", async () => {
  const root = makeFixtureRepo();
  await assert.rejects(
    () => search(root, "provisionResource", { limit: 5, k: -1, env: unresolvableEnv() }),
    /invalid k "-1": expected a finite number >= 0/,
  );
});

test("search: opts.k Infinity is rejected", async () => {
  const root = makeFixtureRepo();
  await assert.rejects(
    () => search(root, "provisionResource", { limit: 5, k: Infinity, env: unresolvableEnv() }),
    /invalid k "Infinity": expected a finite number >= 0/,
  );
});

test("search: opts.k 0 is accepted", async () => {
  const root = makeFixtureRepo();
  const result = await search(root, "provisionResource", { limit: 5, k: 0, env: unresolvableEnv() });
  assert.ok(result.results.length > 0);
});

test("search: opts.k 60 (the documented default) is accepted", async () => {
  const root = makeFixtureRepo();
  const result = await search(root, "provisionResource", { limit: 5, k: 60, env: unresolvableEnv() });
  assert.ok(result.results.length > 0);
});

test("CLI `graft search --k -1` fails loudly and exits non-zero", () => {
  const root = makeFixtureRepo();
  assert.throws(
    () => {
      execFileSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "search", "provisionResource", root, "--k", "-1"],
        { stdio: "pipe" },
      );
    },
    (err: unknown) => {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      assert.match(stderr, /invalid k "-1": expected a finite number >= 0/);
      assert.notEqual((err as { status?: number }).status, 0);
      return true;
    },
  );
});

test("CLI `graft search --k abc` fails loudly and exits non-zero", () => {
  const root = makeFixtureRepo();
  assert.throws(
    () => {
      execFileSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "search", "provisionResource", root, "--k", "abc"],
        { stdio: "pipe" },
      );
    },
    (err: unknown) => {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      assert.match(stderr, /invalid k "NaN": expected a finite number >= 0/);
      assert.notEqual((err as { status?: number }).status, 0);
      return true;
    },
  );
});

test("CLI `graft search --colgrep-mode <bad>` fails loudly instead of silently repairing to hybrid", () => {
  const root = makeFixtureRepo();
  assert.throws(
    () => {
      execFileSync(
        process.execPath,
        ["--import", "tsx", "src/cli.ts", "search", "provisionResource", root, "--colgrep-mode", "sematic"],
        { stdio: "pipe" },
      );
    },
    (err: unknown) => {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      assert.match(stderr, /invalid --colgrep-mode "sematic"; expected hybrid \| semantic \| off/);
      assert.equal((err as { status?: number }).status, 1);
      return true;
    },
  );
});

test("CLI `graft search` on a repo with no graph fails with a clear ✗ message, exit 1", () => {
  const root = mkdtempSync(join(tmpdir(), "graft-search-cmd-cli-nograph-"));
  assert.throws(
    () => {
      execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "search", "anything", root, "--no-refresh"], {
        stdio: "pipe",
      });
    },
    (err: unknown) => {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      assert.match(stderr, /✗.*no graph found — run `graft build` first/);
      assert.equal((err as { status?: number }).status, 1);
      return true;
    },
  );
});

test("CLI `graft search` under a workspace root prints a clear federation error instead of running unscoped", () => {
  const parent = mkdtempSync(join(tmpdir(), "graft-search-cmd-ws-"));
  mkdirSync(join(parent, "graft"), { recursive: true });
  writeFileSync(join(parent, "graft", "workspace.json"), JSON.stringify({ version: 1, children: [] }));

  assert.throws(
    () => {
      execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "search", "anything", parent], { stdio: "pipe" });
    },
    (err: unknown) => {
      const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
      assert.match(stderr, /graft search does not federate across workspace children yet/);
      assert.match(stderr, /graft ask/);
      return true;
    },
  );
});
