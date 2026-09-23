/**
 * `src/search/hybrid.ts` — pure fusion of ColGREP semantic hits with `ask`
 * lexical/graph hits onto graph symbol nodes. No I/O, no process spawning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapHitsToNodes,
  isTestPath,
  rrfFuse,
  fuseSearch,
  renderSearch,
  type SearchCandidate,
} from "../src/search/hybrid.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";
import type { ColgrepHit } from "../src/search/colgrep.js";

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

const graph: GraphV1 = {
  meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: ["ts"] },
  nodes: [
    node({ id: "src/cache.ts", path: "src/cache.ts", span: "L1-L200", kind: "file", name: "cache.ts" }),
    node({
      id: "src/cache.ts#Cache",
      path: "src/cache.ts",
      span: "L10-L190",
      kind: "class",
      name: "Cache",
      signature: "class Cache",
    }),
    node({
      id: "src/cache.ts#Cache.get",
      path: "src/cache.ts",
      span: "L165-L222", // deliberately extends past the class span; still innermost for lines within it
      kind: "method",
      name: "get",
      signature: "get(k: string): number",
      owner: "Cache",
    }),
    node({
      id: "src/util.ts",
      path: "src/util.ts",
      span: "L1-L50",
      kind: "file",
      name: "util.ts",
    }),
  ],
  edges: [],
};

function hit(partial: Partial<ColgrepHit>): ColgrepHit {
  return {
    path: "src/cache.ts",
    absPath: "/repo/src/cache.ts",
    line: 170,
    endLine: 175,
    name: "get",
    qualifiedName: null,
    unitType: "function",
    signature: null,
    language: "ts",
    score: 0.5,
    ...partial,
  };
}

test("mapHitsToNodes: innermost symbol selection", () => {
  const hits = [hit({ line: 170, endLine: 175 })];
  const [c] = mapHitsToNodes(graph, hits);
  assert.equal(c.nodeId, "src/cache.ts#Cache.get");
  assert.equal(c.provenance, "colgrep");
  assert.equal(c.unindexed, undefined);
});

test("mapHitsToNodes: falls back to file node when no symbol span contains the line", () => {
  const hits = [hit({ path: "src/util.ts", line: 40, endLine: 42 })];
  const [c] = mapHitsToNodes(graph, hits);
  assert.equal(c.nodeId, "src/util.ts");
  assert.equal(c.kind, "file");
});

test("mapHitsToNodes: synthetic unindexed candidate when the path isn't in the graph at all", () => {
  const hits = [hit({ path: "src/missing.ts", line: 5, endLine: 9, name: "ghost" })];
  const [c] = mapHitsToNodes(graph, hits);
  assert.equal(c.nodeId, "src/missing.ts");
  assert.equal(c.path, "src/missing.ts");
  assert.equal(c.span, "L5-L9");
  assert.equal(c.name, "ghost");
  assert.equal(c.unindexed, true);
});

test("mapHitsToNodes: a hit starting at a doc comment above the function still lands on the function, not the file", () => {
  const docCommentGraph: GraphV1 = {
    meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: ["go"] },
    nodes: [
      node({
        id: "widget_service.go",
        path: "widget_service.go",
        span: "L1-L139",
        kind: "file",
        name: "widget_service.go",
      }),
      node({
        id: "widget_service.go#CalculateWidgetQuote",
        path: "widget_service.go",
        span: "L12-L126",
        kind: "function",
        name: "CalculateWidgetQuote",
        signature: "func CalculateWidgetQuote(...)",
      }),
    ],
    edges: [],
  };
  // ColGREP's chunk starts at line 9 (the doc comment above the function,
  // which starts at line 12) and ends at the function's closing brace.
  const hits = [hit({ path: "widget_service.go", line: 9, endLine: 126, name: "CalculateWidgetQuote" })];
  const [c] = mapHitsToNodes(docCommentGraph, hits);
  assert.equal(c.nodeId, "widget_service.go#CalculateWidgetQuote");
  assert.equal(c.kind, "function");
});

test("mapHitsToNodes: a raw_code chunk spanning the whole file lands on the file node even though a symbol is fully contained", () => {
  const wholeFileGraph: GraphV1 = {
    meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: ["ts"] },
    nodes: [
      node({ id: "src/big.ts", path: "src/big.ts", span: "L1-L900", kind: "file", name: "big.ts" }),
      node({
        id: "src/big.ts#helper",
        path: "src/big.ts",
        span: "L100-L200",
        kind: "function",
        name: "helper",
        signature: "function helper()",
      }),
    ],
    edges: [],
  };
  const hits = [hit({ path: "src/big.ts", line: 1, endLine: 900, name: "raw_code" })];
  const [c] = mapHitsToNodes(wholeFileGraph, hits);
  assert.equal(c.nodeId, "src/big.ts");
  assert.equal(c.kind, "file");
});

test("mapHitsToNodes: dedupe by nodeId keeps the best (highest) score, preserves rank order", () => {
  const hits = [
    hit({ line: 170, endLine: 175, score: 0.3 }),
    hit({ path: "src/util.ts", line: 40, endLine: 42, score: 0.9 }),
    hit({ line: 168, endLine: 172, score: 0.8 }), // same node (Cache.get), higher score
  ];
  const result = mapHitsToNodes(graph, hits);
  assert.equal(result.length, 2, "deduped to 2 unique nodes");
  // preserves order of first occurrence (rank order), not sorted by score
  assert.equal(result[0].nodeId, "src/cache.ts#Cache.get");
  assert.equal(result[0].rrf, 0.8, "kept the highest score for the duplicate node");
  assert.equal(result[1].nodeId, "src/util.ts");
});

test("mapHitsToNodes: an exact name match wins over a sibling symbol with larger span overlap", () => {
  const g: GraphV1 = {
    meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: ["ts"] },
    nodes: [
      node({ id: "src/f.ts", path: "src/f.ts", span: "L1-L100", kind: "file", name: "f.ts" }),
      node({ id: "src/f.ts#big", path: "src/f.ts", span: "L1-L90", kind: "function", name: "big", signature: "function big()" }),
      node({ id: "src/f.ts#target", path: "src/f.ts", span: "L50-L55", kind: "function", name: "target", signature: "function target()" }),
    ],
    edges: [],
  };
  // The hit's line range overlaps mostly with `big` (90 lines) and only
  // partially with `target` (6 lines), but ColGREP's own unit name is an
  // exact match for `target` — name-first mapping must win over the
  // larger-overlap sibling.
  const hits = [hit({ path: "src/f.ts", line: 1, endLine: 90, name: "target", unitType: "function" })];
  const [c] = mapHitsToNodes(g, hits);
  assert.equal(c.nodeId, "src/f.ts#target");
  assert.equal(c.colgrepMatch, "symbol");
});

test("mapHitsToNodes: name-first also matches an owner-qualified name via the node id suffix", () => {
  const hits = [hit({ path: "src/cache.ts", line: 1, endLine: 2, name: "Cache.get", unitType: "method" })];
  const [c] = mapHitsToNodes(graph, hits);
  assert.equal(c.nodeId, "src/cache.ts#Cache.get");
  assert.equal(c.colgrepMatch, "symbol");
});

test("mapHitsToNodes: a raw_code_N chunk skips name-first and uses overlap, even if a symbol happens to share the name", () => {
  const g: GraphV1 = {
    meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: ["ts"] },
    nodes: [
      node({ id: "src/r.ts", path: "src/r.ts", span: "L1-L100", kind: "file", name: "r.ts" }),
      node({
        id: "src/r.ts#raw_code_7",
        path: "src/r.ts",
        span: "L1-L2",
        kind: "function",
        name: "raw_code_7",
        signature: "function raw_code_7()",
      }),
    ],
    edges: [],
  };
  const hits = [hit({ path: "src/r.ts", line: 1, endLine: 100, name: "raw_code_7", unitType: "function" })];
  const [c] = mapHitsToNodes(g, hits);
  assert.equal(c.nodeId, "src/r.ts", "overlap picks the whole-file node, not the same-named tiny symbol");
  assert.equal(c.colgrepMatch, "file");
});

test("mapHitsToNodes: a symbol-kind hit whose name matches no node falls back to overlap", () => {
  const hits = [hit({ line: 170, endLine: 175, name: "nonexistentSymbol", unitType: "function" })];
  const [c] = mapHitsToNodes(graph, hits);
  assert.equal(c.nodeId, "src/cache.ts#Cache.get", "falls back to overlap and picks the innermost enclosing symbol");
  assert.equal(c.colgrepMatch, "chunk");
});

test("mapHitsToNodes: qualified_name disambiguates two same-named receivers; without it, span decides between the ambiguous bare matches", () => {
  const g: GraphV1 = {
    meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: ["go"] },
    nodes: [
      node({ id: "models.go", path: "models.go", span: "L1-L100", kind: "file", name: "models.go" }),
      node({
        id: "models.go#User.Save",
        path: "models.go",
        span: "L10-L20",
        kind: "method",
        name: "Save",
        signature: "func (u *User) Save() error",
      }),
      node({
        id: "models.go#Order.Save",
        path: "models.go",
        span: "L30-L60",
        kind: "method",
        name: "Save",
        signature: "func (s *Order) Save() error",
      }),
    ],
    edges: [],
  };
  // The hit's line range overlaps ONLY Order.Save's span, but its
  // qualified_name names User.Save exactly — qualified_name wins regardless
  // of span overlap.
  const hitWithQualified = hit({ path: "models.go", line: 30, endLine: 40, name: "Save", unitType: "method", qualifiedName: "User.Save" });
  const [withQualified] = mapHitsToNodes(g, [hitWithQualified]);
  assert.equal(withQualified.nodeId, "models.go#User.Save", "qualified_name picks the right receiver even though span overlaps the other");
  assert.equal(withQualified.colgrepMatch, "symbol");

  // Same hit, no qualified_name — "Save" is ambiguous between the two
  // receivers, so span overlap (which only Order.Save has) decides.
  const hitWithoutQualified = hit({ path: "models.go", line: 30, endLine: 40, name: "Save", unitType: "method" });
  const [withoutQualified] = mapHitsToNodes(g, [hitWithoutQualified]);
  assert.equal(withoutQualified.nodeId, "models.go#Order.Save", "without qualified_name, span overlap decides between ambiguous bare matches");
});

test("mapHitsToNodes: a class and a method sharing a name never cross-match on unitType, even when the class's span overlaps more", () => {
  const g: GraphV1 = {
    meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: ["ts"] },
    nodes: [
      node({ id: "x.ts", path: "x.ts", span: "L1-L100", kind: "file", name: "x.ts" }),
      // A giant class named "Widget" whose span fully covers the hit —
      // without a kind filter, the old first-match/overlap logic would pick
      // this over the small function below.
      node({ id: "x.ts#Widget", path: "x.ts", span: "L1-L100", kind: "class", name: "Widget", signature: "class Widget" }),
      node({ id: "x.ts#fn.Widget", path: "x.ts", span: "L60-L65", kind: "function", name: "Widget", signature: "function Widget()" }),
    ],
    edges: [],
  };
  const hits = [hit({ path: "x.ts", line: 60, endLine: 65, name: "Widget", unitType: "function" })];
  const [c] = mapHitsToNodes(g, hits);
  assert.equal(c.nodeId, "x.ts#fn.Widget", "unitType:function must never resolve to the class node sharing the name");
  assert.equal(c.colgrepMatch, "symbol");
});

test("mapHitsToNodes: qualified-name resolution respects kind — a package-qualified function never resolves to a same-shaped method node", () => {
  const g: GraphV1 = {
    meta: { version: 1, nodeCount: 0, edgeCount: 0, languages: ["go"] },
    nodes: [
      node({ id: "services.go", path: "services.go", span: "L1-L200", kind: "file", name: "services.go" }),
      node({
        id: "services.go#ProcessWidget",
        path: "services.go",
        span: "L10-L20",
        kind: "function",
        name: "ProcessWidget",
        signature: "func ProcessWidget(...)",
      }),
      node({
        id: "services.go#services.ProcessWidget",
        path: "services.go",
        span: "L50-L80",
        kind: "method",
        name: "ProcessWidget",
        signature: "func (s *services) ProcessWidget(...)",
      }),
    ],
    edges: [],
  };
  // A ColGREP hit for the package-qualified top-level FUNCTION `ProcessWidget`
  // reports qualified_name "services.ProcessWidget" (package.function) — the
  // exact same "Owner.Member" shape a receiver METHOD's owner-qualified name
  // takes, and it happens to collide with the id suffix of an unrelated method
  // node here. Kind must disambiguate: the hit's unit_type is "function", so it
  // must resolve to the function node, never the method.
  const hits = [
    hit({
      path: "services.go",
      line: 10,
      endLine: 20,
      name: "ProcessWidget",
      qualifiedName: "services.ProcessWidget",
      unitType: "function",
    }),
  ];
  const [c] = mapHitsToNodes(g, hits);
  assert.equal(c.nodeId, "services.go#ProcessWidget");
  assert.equal(c.kind, "function");
});

test("isTestPath: positives", () => {
  assert.equal(isTestPath("test/search-hybrid.test.ts"), true);
  assert.equal(isTestPath("src/foo.spec.ts"), true);
  assert.equal(isTestPath("test/helpers.ts"), true);
  assert.equal(isTestPath("tests/helpers.ts"), true);
  assert.equal(isTestPath("src/__tests__/foo.ts"), true);
  assert.equal(isTestPath("e2e/flow.ts"), true);
  assert.equal(isTestPath("src/testdata/fixture.json"), true);
  assert.equal(isTestPath("fixtures/graph.json"), true);
  assert.equal(isTestPath("server/internal/rpc/account_profile_test.go"), true);
  assert.equal(isTestPath("request_router_support_test.go"), true);
  assert.equal(isTestPath("src/foo_test.ts"), true);
  assert.equal(isTestPath("client/src/components/Foo.stories.tsx"), true);
  assert.equal(isTestPath("src/__mocks__/foo.ts"), true);
  assert.equal(isTestPath("spec/foo.ts"), true);
});

test("isTestPath: negatives", () => {
  assert.equal(isTestPath("src/cache.ts"), false);
  assert.equal(isTestPath("src/search/hybrid.ts"), false);
  assert.equal(isTestPath("src/contest/foo.ts"), false, "substring 'test' inside a segment name doesn't count");
  assert.equal(isTestPath("src/attest.ts"), false);
  assert.equal(isTestPath("tools/build.ts"), false, "real code lives under tools/ in many repos — no longer a default test segment");
  assert.equal(isTestPath("TOOLS/build.ts"), false);
  assert.equal(isTestPath("src/mocks/foo.ts"), false, "bare 'mocks' segment is real code in many repos — only __mocks__ is a default test segment");
});

test("rrfFuse: exact numeric score for a shared id across two lists", () => {
  const lists = [
    { source: "ask" as const, items: [{ nodeId: "a" }, { nodeId: "b" }] },
    { source: "semantic" as const, items: [{ nodeId: "b" }, { nodeId: "c" }] },
  ];
  const result = rrfFuse(lists);
  // "a": rank 1 in ask only -> 1/(60+1)
  assert.equal(result.get("a")!.rrf, 1 / 61);
  // "b": rank 2 in ask, rank 1 in semantic -> 1/62 + 1/61
  assert.equal(result.get("b")!.rrf, 1 / 62 + 1 / 61);
  // "c": rank 2 in semantic -> 1/62
  assert.equal(result.get("c")!.rrf, 1 / 62);
  assert.deepEqual(result.get("b")!.ranks, { ask: 2, semantic: 1 });
});

test("rrfFuse: honors a custom k", () => {
  const lists = [{ source: "ask" as const, items: [{ nodeId: "a" }] }];
  const result = rrfFuse(lists, 10);
  assert.equal(result.get("a")!.rrf, 1 / 11);
});

test("fuseSearch: provenance tagging for all four values + tie-break order", () => {
  const askHits = [
    { nodeId: "src/cache.ts#Cache.get", path: "src/cache.ts", span: "L165-L222", name: "get", kind: "method", signature: "get(k): number" },
    { nodeId: "only-in-ask", path: "src/a.ts", span: "L1-L2", name: "onlyAsk", kind: "function", signature: null },
    { nodeId: "graph-hit", path: "src/g.ts", span: "L1-L2", name: "graphHit", kind: "function", signature: null, fromGraph: true },
  ];
  const semantic: SearchCandidate[] = [
    {
      nodeId: "src/cache.ts#Cache.get",
      path: "src/cache.ts",
      span: "L165-L222",
      name: "get",
      kind: "method",
      signature: "get(k): number",
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
    {
      nodeId: "only-in-semantic",
      path: "src/s.ts",
      span: "L1-L2",
      name: "onlySemantic",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
  ];

  const result = fuseSearch({ askHits, semantic, includeTests: true });
  const byId = new Map(result.map((r) => [r.nodeId, r]));
  assert.equal(byId.get("src/cache.ts#Cache.get")!.provenance, "both");
  assert.equal(byId.get("only-in-ask")!.provenance, "lexical");
  assert.equal(byId.get("graph-hit")!.provenance, "graph");
  assert.equal(byId.get("only-in-semantic")!.provenance, "colgrep");
});

test("fuseSearch: tier-2 alternation ties (equal top rank) prefer ask first", () => {
  // "zzz" is rank 1 in the ask-only list; "aaa" is rank 1 in the
  // semantic-only list — same top rank, so ask goes first.
  const askHits = [{ nodeId: "zzz", path: "src/z.ts", span: "L1-L2", name: "z", kind: "function", signature: null }];
  const semantic: SearchCandidate[] = [
    { nodeId: "aaa", path: "src/a.ts", span: "L1-L2", name: "a", kind: "function", signature: null, provenance: "colgrep", rrf: 0, ranks: {} },
  ];
  const result = fuseSearch({ askHits, semantic, includeTests: true, limit: 10 });
  assert.equal(result[0].nodeId, "zzz");
  assert.equal(result[1].nodeId, "aaa");
});

test("fuseSearch: union-preserving merge — disjoint 5+5 lists interleave ask1,sem1,ask2,sem2,ask3 when ask's top rank is better", () => {
  const askHits = Array.from({ length: 5 }, (_, i) => ({
    nodeId: `a${i + 1}`,
    path: `src/a${i + 1}.ts`,
    span: "L1-L2",
    name: `a${i + 1}`,
    kind: "function",
    signature: null,
  }));
  const semantic: SearchCandidate[] = Array.from({ length: 5 }, (_, i) => ({
    nodeId: `s${i + 1}`,
    path: `src/s${i + 1}.ts`,
    span: "L1-L2",
    name: `s${i + 1}`,
    kind: "function",
    signature: null,
    provenance: "colgrep",
    rrf: 0,
    ranks: {},
  }));
  const result = fuseSearch({ askHits, semantic, includeTests: true, limit: 5 });
  assert.deepEqual(
    result.map((r) => r.nodeId),
    ["a1", "s1", "a2", "s2", "a3"],
  );
});

test("fuseSearch: union-preserving merge — semantic-first alternation when semantic's top remaining rank is better", () => {
  // ask's best remaining (ask-only) candidate is rank 2 ('shared' occupies
  // rank 1 and lands in tier 1); semantic has an extra semantic-only
  // candidate at rank 1 ('s0'), so semantic's best remaining rank (1) beats
  // ask's (2) and tier 2 starts with semantic.
  const askHits = [
    { nodeId: "shared", path: "src/shared.ts", span: "L1-L2", name: "shared", kind: "function", signature: null },
    { nodeId: "a2", path: "src/a2.ts", span: "L1-L2", name: "a2", kind: "function", signature: null },
  ];
  const semantic: SearchCandidate[] = [
    {
      nodeId: "s0",
      path: "src/s0.ts",
      span: "L1-L2",
      name: "s0",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
    {
      nodeId: "shared",
      path: "src/shared.ts",
      span: "L1-L2",
      name: "shared",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
    {
      nodeId: "s2",
      path: "src/s2.ts",
      span: "L1-L2",
      name: "s2",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
  ];
  const result = fuseSearch({ askHits, semantic, includeTests: true, limit: 10 });
  assert.deepEqual(
    result.map((r) => r.nodeId),
    ["shared", "s0", "a2", "s2"],
  );
});

test("fuseSearch: union-preserving merge — a shared id lands first with provenance 'both', then alternation resumes with the remaining ranks", () => {
  const askHits = [
    { nodeId: "shared", path: "src/shared.ts", span: "L1-L2", name: "shared", kind: "function", signature: null },
    { nodeId: "a2", path: "src/a2.ts", span: "L1-L2", name: "a2", kind: "function", signature: null },
    { nodeId: "a3", path: "src/a3.ts", span: "L1-L2", name: "a3", kind: "function", signature: null },
  ];
  const semantic: SearchCandidate[] = [
    {
      nodeId: "shared",
      path: "src/shared.ts",
      span: "L1-L2",
      name: "shared",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
    {
      nodeId: "s2",
      path: "src/s2.ts",
      span: "L1-L2",
      name: "s2",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
    {
      nodeId: "s3",
      path: "src/s3.ts",
      span: "L1-L2",
      name: "s3",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
  ];
  const result = fuseSearch({ askHits, semantic, includeTests: true, limit: 10 });
  assert.equal(result[0].nodeId, "shared");
  assert.equal(result[0].provenance, "both");
  assert.deepEqual(
    result.map((r) => r.nodeId),
    ["shared", "a2", "s2", "a3", "s3"],
  );
});

test("fuseSearch: union-preserving merge — tier 1 ('both') always outranks tier 2 regardless of the tier-2 candidate's own better list rank", () => {
  const askHits = [
    { nodeId: "askOnlyRank1", path: "src/askonly.ts", span: "L1-L2", name: "askOnlyRank1", kind: "function", signature: null },
    { nodeId: "bothRank2", path: "src/both.ts", span: "L1-L2", name: "bothRank2", kind: "function", signature: null },
  ];
  const semantic: SearchCandidate[] = [
    {
      nodeId: "bothRank2",
      path: "src/both.ts",
      span: "L1-L2",
      name: "bothRank2",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
  ];
  const result = fuseSearch({ askHits, semantic, includeTests: true, limit: 10 });
  assert.equal(result[0].nodeId, "bothRank2", "the 'both' hit leads even though its own ask rank (2) is worse");
  assert.equal(result[0].provenance, "both");
  assert.equal(result[1].nodeId, "askOnlyRank1");
});

test("fuseSearch: limit slices after tiering, not before", () => {
  const askHits = [
    { nodeId: "shared", path: "src/shared.ts", span: "L1-L2", name: "shared", kind: "function", signature: null },
    { nodeId: "a2", path: "src/a2.ts", span: "L1-L2", name: "a2", kind: "function", signature: null },
  ];
  const semantic: SearchCandidate[] = [
    {
      nodeId: "shared",
      path: "src/shared.ts",
      span: "L1-L2",
      name: "shared",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
    {
      nodeId: "s2",
      path: "src/s2.ts",
      span: "L1-L2",
      name: "s2",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
  ];
  const result = fuseSearch({ askHits, semantic, includeTests: true, limit: 2 });
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((r) => r.nodeId),
    ["shared", "a2"],
  );
});

test("fuseSearch: filters test paths unless includeTests, and respects limit", () => {
  const askHits = [
    { nodeId: "src/real.ts#fn", path: "src/real.ts", span: "L1-L2", name: "fn", kind: "function", signature: null },
    { nodeId: "test/foo.test.ts#fn", path: "test/foo.test.ts", span: "L1-L2", name: "fn", kind: "function", signature: null },
  ];
  const filtered = fuseSearch({ askHits, semantic: [] });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].nodeId, "src/real.ts#fn");

  const included = fuseSearch({ askHits, semantic: [], includeTests: true });
  assert.equal(included.length, 2);

  const limited = fuseSearch({ askHits, semantic: [], includeTests: true, limit: 1 });
  assert.equal(limited.length, 1);
});

test("fuseSearch: ask metadata wins for shared nodes over semantic metadata", () => {
  const askHits = [
    { nodeId: "shared", path: "src/shared.ts", span: "L1-L2", name: "askName", kind: "function", signature: "ask sig" },
  ];
  const semantic: SearchCandidate[] = [
    {
      nodeId: "shared",
      path: "src/shared.ts",
      span: "L1-L2",
      name: "semanticName",
      kind: "function",
      signature: "semantic sig",
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
  ];
  const [result] = fuseSearch({ askHits, semantic });
  assert.equal(result.name, "askName");
  assert.equal(result.signature, "ask sig");
});

test("fuseSearch: a semantic FILE hit and an ask SYMBOL hit for the same path fuse into one 'same-file' result, not two, and never 'both'", () => {
  const askHits = [
    {
      nodeId: "resource_records.go#AssignResourceOwner",
      path: "resource_records.go",
      span: "L10-L20",
      name: "AssignResourceOwner",
      kind: "function",
      signature: "func AssignResourceOwner(...)",
    },
  ];
  const semantic: SearchCandidate[] = [
    {
      nodeId: "resource_records.go",
      path: "resource_records.go",
      span: "L1-L50",
      name: "resource_records.go",
      kind: "file",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
  ];
  const result = fuseSearch({ askHits, semantic, includeTests: true });
  assert.equal(result.length, 1, "the file candidate and symbol candidate fuse into one result");
  assert.equal(result[0].nodeId, "resource_records.go#AssignResourceOwner");
  assert.equal(result[0].provenance, "same-file", "a file-level re-key is real signal but not node-level agreement");
  assert.equal(result[0].colgrepMatch, "file");
});

test("fuseSearch: when several ask symbols share the semantic-hit file, only the best-ranked one is credited", () => {
  const askHits = [
    {
      nodeId: "records.go#Best",
      path: "records.go",
      span: "L1-L5",
      name: "Best",
      kind: "function",
      signature: null,
    },
    {
      nodeId: "records.go#Second",
      path: "records.go",
      span: "L10-L15",
      name: "Second",
      kind: "function",
      signature: null,
    },
  ];
  const semantic: SearchCandidate[] = [
    {
      nodeId: "records.go",
      path: "records.go",
      span: "L1-L50",
      name: "records.go",
      kind: "file",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
  ];
  const result = fuseSearch({ askHits, semantic, includeTests: true });
  const byId = new Map(result.map((r) => [r.nodeId, r]));
  assert.equal(byId.get("records.go#Best")!.provenance, "same-file");
  assert.equal(byId.get("records.go#Second")!.provenance, "lexical");
  assert.equal(result.find((r) => r.nodeId === "records.go"), undefined, "the file candidate is dropped");
});

test("fuseSearch: a genuine node-level match survives even when a same-file re-key would also target it — stays 'both', not 'same-file'", () => {
  const askHits = [
    { nodeId: "records.go#Handle", path: "records.go", span: "L10-L20", name: "Handle", kind: "function", signature: null },
  ];
  const semantic: SearchCandidate[] = [
    {
      // Rank 1: a direct function-level hit — genuine node-level agreement,
      // not a re-key.
      nodeId: "records.go#Handle",
      path: "records.go",
      span: "L10-L20",
      name: "Handle",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
      colgrepMatch: "symbol",
    },
    {
      // Rank 2: a whole-file chunk from the same file, which re-keys onto
      // the same ask nodeId — must dedupe away, not manufacture a second
      // entry or downgrade the real agreement above to 'same-file'.
      nodeId: "records.go",
      path: "records.go",
      span: "L1-L50",
      name: "records.go",
      kind: "file",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
      colgrepMatch: "file",
    },
  ];
  const result = fuseSearch({ askHits, semantic, includeTests: true });
  assert.equal(result.length, 1, "the direct symbol match and the re-keyed file chunk dedupe to one node");
  assert.equal(result[0].nodeId, "records.go#Handle");
  assert.equal(result[0].provenance, "both");
  assert.equal(result[0].rrf, 1 / 61 + 1 / 61, "rrf = 1/(k+rank_ask=1) + 1/(k+best_semantic_rank=1)");
  assert.equal(result[0].ranks.semantic, 1, "dedupe keeps the earlier (rank 1) semantic occurrence, not the rank-2 re-keyed duplicate");
});

test("fuseSearch: tier ordering — 'both' outranks 'same-file', which outranks tier-2 alternation", () => {
  const askHits = [
    { nodeId: "bothNode", path: "src/both.ts", span: "L1-L2", name: "bothNode", kind: "function", signature: null },
    { nodeId: "records.go#Handle", path: "records.go", span: "L10-L20", name: "Handle", kind: "function", signature: null },
    { nodeId: "askOnly", path: "src/askonly.ts", span: "L1-L2", name: "askOnly", kind: "function", signature: null },
  ];
  const semantic: SearchCandidate[] = [
    {
      nodeId: "bothNode",
      path: "src/both.ts",
      span: "L1-L2",
      name: "bothNode",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
    {
      nodeId: "records.go",
      path: "records.go",
      span: "L1-L50",
      name: "records.go",
      kind: "file",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
    {
      nodeId: "semOnly",
      path: "src/semonly.ts",
      span: "L1-L2",
      name: "semOnly",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
  ];
  const result = fuseSearch({ askHits, semantic, includeTests: true, limit: 10 });
  assert.equal(result[0].nodeId, "bothNode");
  assert.equal(result[0].provenance, "both");
  assert.equal(result[1].nodeId, "records.go#Handle");
  assert.equal(result[1].provenance, "same-file");
  assert.deepEqual(
    result.slice(2).map((r) => r.nodeId),
    ["askOnly", "semOnly"],
    "tier 2 ties (equal top rank) still favor ask first",
  );
});

test("fuseSearch: askOnlyRankCap keeps a shared node at rank 12 as tier-1 'both' while excluding ask ranks 11-12 from tier-2 ask-only", () => {
  // 12 ask hits; ask rank 12 ("a12") is also semantic's #1 hit, so it should
  // fuse to 'both' regardless of askOnlyRankCap (agreement detection must
  // not depend on the ask-only display cap). Ask ranks 11 and 12 are
  // otherwise-unmatched-by-semantic ask-only candidates; rank 12 IS matched
  // (it's the shared node), so only rank 11 is a true ask-only candidate to
  // check against the cap.
  const askHits = Array.from({ length: 12 }, (_, i) => ({
    nodeId: `a${i + 1}`,
    path: `src/a${i + 1}.ts`,
    span: "L1-L2",
    name: `a${i + 1}`,
    kind: "function",
    signature: null,
  }));
  const semantic: SearchCandidate[] = [
    {
      nodeId: "a12",
      path: "src/a12.ts",
      span: "L1-L2",
      name: "a12",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
    {
      nodeId: "s2",
      path: "src/s2.ts",
      span: "L1-L2",
      name: "s2",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
    {
      nodeId: "s3",
      path: "src/s3.ts",
      span: "L1-L2",
      name: "s3",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
  ];

  const capped = fuseSearch({ askHits, semantic, includeTests: true, limit: 20, askOnlyRankCap: 10 });
  const cappedById = new Map(capped.map((r) => [r.nodeId, r]));
  assert.equal(cappedById.get("a12")!.provenance, "both", "the shared node fuses to 'both' despite its ask rank (12) exceeding the cap");
  assert.equal(cappedById.has("a11"), false, "ask rank 11 (ask-only, over the cap) is excluded");
  assert.equal(cappedById.has("a10"), true, "ask rank 10 (ask-only, at the cap) is still included");

  const uncapped = fuseSearch({ askHits, semantic, includeTests: true, limit: 20 });
  const uncappedById = new Map(uncapped.map((r) => [r.nodeId, r]));
  assert.equal(uncappedById.get("a12")!.provenance, "both");
  assert.equal(uncappedById.has("a11"), true, "without a cap, ask rank 11 is included as ask-only");
});

test("renderSearch: json shape", () => {
  const results: SearchCandidate[] = [
    {
      nodeId: "src/cache.ts#Cache.get",
      path: "src/cache.ts",
      span: "L165-L222",
      name: "get",
      kind: "method",
      signature: "get(k: string): number",
      provenance: "both",
      rrf: 0.03,
      ranks: { ask: 1, semantic: 2 },
    },
  ];
  const out = renderSearch(results, { json: true, note: "a note" });
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.results, results);
  assert.equal(parsed.note, "a note");
});

test("renderSearch: compact line format, unindexed suffix, trailing note", () => {
  const results: SearchCandidate[] = [
    {
      nodeId: "src/cache.ts#Cache.get",
      path: "src/cache.ts",
      span: "L165-L222",
      name: "get",
      kind: "method",
      signature: "get(k: string): number\n  extra body line",
      provenance: "both",
      rrf: 0.03,
      ranks: { ask: 1, semantic: 2 },
    },
    {
      nodeId: "src/missing.ts",
      path: "src/missing.ts",
      span: "L5-L9",
      name: "ghost",
      kind: null,
      signature: null,
      provenance: "colgrep",
      rrf: 0.01,
      ranks: { semantic: 1 },
      unindexed: true,
    },
  ];
  const out = renderSearch(results, { note: "colgrep not on PATH" });
  const lines = out.split("\n");
  assert.equal(lines[0], "1. src/cache.ts:L165-L222 · get · get(k: string): number · [both]");
  assert.equal(lines[1], "2. src/missing.ts:L5-L9 · ghost ·  · [colgrep] (unindexed)");
  assert.equal(lines[2], "colgrep not on PATH");
});

// ── `_ablation` (internal-only, `@internal`; see SearchAblation) ──

/** Shared fixture for the `sameFile` ablation tests: ask ranks "shared"
 * (rank 1, the symbol colgrep's file hit re-keys onto), "a2" (rank 2), "a3"
 * (rank 3); semantic ranks a FILE hit for "shared"'s path (rank 1, re-keys
 * under "tier1b"/"tier2") and colgrep-only "s2" (rank 2). */
function sameFileAblationFixture(): { askHits: any[]; semantic: SearchCandidate[] } {
  const askHits = [
    { nodeId: "shared", path: "src/shared.ts", span: "L1-L2", name: "shared", kind: "function", signature: null },
    { nodeId: "a2", path: "src/a2.ts", span: "L1-L2", name: "a2", kind: "function", signature: null },
    { nodeId: "a3", path: "src/a3.ts", span: "L1-L2", name: "a3", kind: "function", signature: null },
  ];
  const semantic: SearchCandidate[] = [
    {
      nodeId: "src/shared.ts",
      path: "src/shared.ts",
      span: "L1-L50",
      name: "shared.ts",
      kind: "file",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
      colgrepMatch: "file",
    },
    {
      nodeId: "s2",
      path: "src/s2.ts",
      span: "L1-L2",
      name: "s2",
      kind: "function",
      signature: null,
      provenance: "colgrep",
      rrf: 0,
      ranks: {},
    },
  ];
  return { askHits, semantic };
}

test("fuseSearch: _ablation.sameFile default ('tier1b') matches current (no-ablation) behavior byte-for-byte", () => {
  const { askHits, semantic } = sameFileAblationFixture();
  const withoutAblation = fuseSearch({ askHits, semantic, includeTests: true, limit: 10 });
  const withDefaultAblation = fuseSearch({ askHits, semantic, includeTests: true, limit: 10, _ablation: {} });
  const withExplicitTier1b = fuseSearch({ askHits, semantic, includeTests: true, limit: 10, _ablation: { sameFile: "tier1b" } });
  assert.deepEqual(withDefaultAblation, withoutAblation);
  assert.deepEqual(withExplicitTier1b, withoutAblation);
  assert.deepEqual(
    withoutAblation.map((r) => r.nodeId),
    ["shared", "a2", "s2", "a3"],
  );
  assert.equal(withoutAblation[0].provenance, "same-file");
});

test("fuseSearch: _ablation.sameFile 'tier2' — the re-keyed node keeps provenance 'same-file' but joins alternation at its ask rank, not tier 1b", () => {
  const { askHits, semantic } = sameFileAblationFixture();
  const result = fuseSearch({ askHits, semantic, includeTests: true, limit: 10, _ablation: { sameFile: "tier2" } });
  assert.deepEqual(
    result.map((r) => r.nodeId),
    ["shared", "s2", "a2", "a3"],
    "'shared' still sits at its ask rank (1) inside alternation, not promoted to a dedicated tier above tier 2",
  );
  assert.equal(result[0].provenance, "same-file", "provenance is unchanged by the placement ablation");
});

test("fuseSearch: _ablation.sameFile 'off' — no re-key at all; the colgrep file candidate stays separate with provenance 'colgrep'", () => {
  const { askHits, semantic } = sameFileAblationFixture();
  const result = fuseSearch({ askHits, semantic, includeTests: true, limit: 10, _ablation: { sameFile: "off" } });
  const byId = new Map(result.map((r) => [r.nodeId, r]));
  assert.equal(byId.get("shared")!.provenance, "lexical", "ask's own symbol hit, no re-key credit");
  assert.equal(byId.get("src/shared.ts")!.provenance, "colgrep", "the file candidate never re-keys under 'off'");
  assert.equal(byId.get("src/shared.ts")!.kind, "file");
  assert.deepEqual(
    result.map((r) => r.nodeId),
    ["shared", "src/shared.ts", "a2", "s2", "a3"],
  );
});

test("fuseSearch: _ablation.ordering 'rrf' sorts by rrf desc / nodeId asc, no tiers — differs from tiered order in a constructed case", () => {
  // Tiered alternation starts with ask (tie: askTop=1 == semTop=1, ties go
  // ask) giving z1 before a1; plain rrf ties on score and breaks by nodeId
  // asc, putting "a1" before "z1" — the two orderings genuinely diverge.
  const askHits = [
    { nodeId: "z1", path: "src/z1.ts", span: "L1-L2", name: "z1", kind: "function", signature: null },
    { nodeId: "z2", path: "src/z2.ts", span: "L1-L2", name: "z2", kind: "function", signature: null },
    { nodeId: "z3", path: "src/z3.ts", span: "L1-L2", name: "z3", kind: "function", signature: null },
  ];
  const semantic: SearchCandidate[] = [
    { nodeId: "a1", path: "src/a1.ts", span: "L1-L2", name: "a1", kind: "function", signature: null, provenance: "colgrep", rrf: 0, ranks: {} },
    { nodeId: "a2", path: "src/a2.ts", span: "L1-L2", name: "a2", kind: "function", signature: null, provenance: "colgrep", rrf: 0, ranks: {} },
  ];

  const tiered = fuseSearch({ askHits, semantic, includeTests: true, limit: 10 });
  assert.deepEqual(
    tiered.map((r) => r.nodeId),
    ["z1", "a1", "z2", "a2", "z3"],
    "sanity: tiered alternation order",
  );

  const rrfOrdered = fuseSearch({ askHits, semantic, includeTests: true, limit: 10, _ablation: { ordering: "rrf" } });
  assert.deepEqual(
    rrfOrdered.map((r) => r.nodeId),
    ["a1", "z1", "a2", "z2", "z3"],
    "plain rrf-desc/nodeId-asc order differs from the tiered alternation above",
  );
});

test("fuseSearch: askOnlyRankCap still applies under _ablation.ordering 'rrf' — capped ask-only nodes are dropped, 'both'/colgrep-only survive", () => {
  const askHits = Array.from({ length: 12 }, (_, i) => ({
    nodeId: `a${i + 1}`,
    path: `src/a${i + 1}.ts`,
    span: "L1-L2",
    name: `a${i + 1}`,
    kind: "function",
    signature: null,
  }));
  const semantic: SearchCandidate[] = [
    { nodeId: "a12", path: "src/a12.ts", span: "L1-L2", name: "a12", kind: "function", signature: null, provenance: "colgrep", rrf: 0, ranks: {} },
    { nodeId: "s2", path: "src/s2.ts", span: "L1-L2", name: "s2", kind: "function", signature: null, provenance: "colgrep", rrf: 0, ranks: {} },
  ];
  const result = fuseSearch({
    askHits,
    semantic,
    includeTests: true,
    limit: 20,
    askOnlyRankCap: 10,
    _ablation: { ordering: "rrf" },
  });
  const byId = new Map(result.map((r) => [r.nodeId, r]));
  assert.equal(byId.get("a12")!.provenance, "both", "'both' survives the cap regardless of ordering");
  assert.equal(byId.has("a11"), false, "ask-only rank 11 (over the cap) is dropped under rrf ordering too");
  assert.equal(byId.has("a10"), true, "ask-only rank 10 (at the cap) survives");
  assert.equal(byId.has("s2"), true, "colgrep-only nodes are never dropped by the ask-only cap");
});

test("fuseSearch: askOnlyRankCap still applies under _ablation.sameFile 'tier2' — a same-file node past the cap is dropped entirely", () => {
  const askHits = Array.from({ length: 11 }, (_, i) => ({
    nodeId: `a${i + 1}`,
    path: `src/a${i + 1}.ts`,
    span: "L1-L2",
    name: `a${i + 1}`,
    kind: "function",
    signature: null,
  }));
  // "a11" (ask rank 11, over a cap of 10) also gets a colgrep FILE hit for
  // its path — under 'tier2' that would normally join the ask-only
  // alternation list at rank 11, but the cap must still drop it.
  const semantic: SearchCandidate[] = [
    { nodeId: "src/a11.ts", path: "src/a11.ts", span: "L1-L50", name: "a11.ts", kind: "file", signature: null, provenance: "colgrep", rrf: 0, ranks: {}, colgrepMatch: "file" },
    { nodeId: "s2", path: "src/s2.ts", span: "L1-L2", name: "s2", kind: "function", signature: null, provenance: "colgrep", rrf: 0, ranks: {} },
  ];
  const capped = fuseSearch({
    askHits,
    semantic,
    includeTests: true,
    limit: 20,
    askOnlyRankCap: 10,
    _ablation: { sameFile: "tier2" },
  });
  assert.equal(capped.find((r) => r.nodeId === "a11"), undefined, "same-file node past the cap is dropped, not just demoted");

  const uncapped = fuseSearch({
    askHits,
    semantic,
    includeTests: true,
    limit: 20,
    _ablation: { sameFile: "tier2" },
  });
  const uncappedById = new Map(uncapped.map((r) => [r.nodeId, r]));
  assert.equal(uncappedById.get("a11")?.provenance, "same-file", "without a cap, the same-file node at rank 11 survives");
});

test("fuseSearch: askOnlyRankCap applies to a same-file node under combined _ablation.sameFile 'tier2' + ordering 'rrf'", () => {
  const askHits = Array.from({ length: 11 }, (_, i) => ({
    nodeId: `a${i + 1}`,
    path: `src/a${i + 1}.ts`,
    span: "L1-L2",
    name: `a${i + 1}`,
    kind: "function",
    signature: null,
  }));
  // "a11" (ask rank 11, over a cap of 10) gets a colgrep FILE hit for its
  // path — under 'tier2' it's excluded from tier 1b and, since it's marked
  // as a same-file node, must also be capped by ask rank under plain rrf
  // ordering, exactly like a true ask-only ('lexical'/'graph') node is.
  const semantic: SearchCandidate[] = [
    { nodeId: "src/a11.ts", path: "src/a11.ts", span: "L1-L50", name: "a11.ts", kind: "file", signature: null, provenance: "colgrep", rrf: 0, ranks: {}, colgrepMatch: "file" },
  ];
  const capped = fuseSearch({
    askHits,
    semantic,
    includeTests: true,
    limit: 20,
    askOnlyRankCap: 10,
    _ablation: { sameFile: "tier2", ordering: "rrf" },
  });
  assert.equal(capped.find((r) => r.nodeId === "a11"), undefined, "same-file node past the cap is dropped under rrf ordering too");

  const uncapped = fuseSearch({
    askHits,
    semantic,
    includeTests: true,
    limit: 20,
    _ablation: { sameFile: "tier2", ordering: "rrf" },
  });
  assert.ok(uncapped.find((r) => r.nodeId === "a11"), "without a cap, the same-file node at rank 11 survives under rrf ordering");

  // Default sameFile mode ('tier1b') is unaffected by this cap change: the
  // re-keyed 'same-file' node is never treated as ask-only for capping.
  const defaultMode = fuseSearch({
    askHits,
    semantic,
    includeTests: true,
    limit: 20,
    askOnlyRankCap: 10,
    _ablation: { ordering: "rrf" },
  });
  const a11Default = defaultMode.find((r) => r.nodeId === "a11");
  assert.ok(a11Default, "default sameFile mode ('tier1b') keeps the same-file node past the ask-only cap");
  assert.equal(a11Default!.provenance, "same-file");
});

test("renderSearch: same-file gets its own tag", () => {
  const results: SearchCandidate[] = [
    {
      nodeId: "records.go#Handle",
      path: "records.go",
      span: "L10-L20",
      name: "Handle",
      kind: "function",
      signature: "func Handle()",
      provenance: "same-file",
      rrf: 0.02,
      ranks: { ask: 1, semantic: 2 },
      colgrepMatch: "file",
    },
  ];
  const out = renderSearch(results);
  assert.equal(out, "1. records.go:L10-L20 · Handle · func Handle() · [same-file]");
});
