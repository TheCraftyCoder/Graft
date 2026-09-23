/**
 * `src/search/hybrid.ts` — the pure fusion core for `graft search`: maps
 * ColGREP semantic hits onto graph symbol nodes, reciprocal-rank-fuses them
 * with the existing `ask` ranking, and renders the merged, provenance-tagged
 * result list. No I/O, no process spawning — every input here is already an
 * in-memory value (`GraphV1`, `ColgrepHit[]`, `ask`'s hits).
 */
import type { GraphV1, NodeV1 } from "../graph/types.js";
import type { ColgrepHit } from "./colgrep.js";

/** `same-file` is a colgrep FILE candidate re-keyed onto an ask SYMBOL hit
 * for the same path (see `fuseSearch`) — real signal, but weaker than true
 * node-level agreement, so it is never tagged `both`. `both` is reserved for
 * a nodeId the colgrep list actually contains WITHOUT re-keying — it means
 * agreement between the two retrieval systems (`ask` and ColGREP), the
 * strongest signal fusion has. */
export type Provenance = "lexical" | "graph" | "colgrep" | "both" | "same-file";

export interface SearchCandidate {
  nodeId: string;
  path: string;
  span: string | null;
  name: string;
  kind: string | null;
  signature: string | null;
  provenance: Provenance;
  rrf: number;
  ranks: { ask?: number; semantic?: number };
  unindexed?: boolean;
  /** How this candidate was matched to its node: `"symbol"` (ColGREP's own
   * unit name/qualified name matched a symbol node directly), `"file"`
   * (fell back to the containing file node), `"chunk"` (fell back to a
   * symbol node via span overlap, e.g. a raw chunk), or `null` when there is
   * no colgrep match at all (an ask-only candidate, or an unindexed
   * synthetic candidate). */
  colgrepMatch?: "symbol" | "file" | "chunk" | null;
}

/** One `ask` hit, as fed into `fuseSearch`. `fromGraph` marks a hit that came
 * from graph traversal (calls/callers) rather than lexical matching, tagged
 * provenance `"graph"` when it has no matching semantic hit. */
export interface AskSearchHit {
  nodeId: string;
  path: string;
  span: string | null;
  name: string;
  kind?: string | null;
  signature?: string | null;
  fromGraph?: boolean;
}

const SPAN_RE = /^L(\d+)-L(\d+)$/;

/** Parses a `"L<a>-L<b>"` span into `[a, b]`, or null if malformed. */
function parseSpan(span: string): [number, number] | null {
  const m = SPAN_RE.exec(span);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/** ColGREP unit types treated as a named symbol for name-first matching
 * (below), rather than an opaque chunk. */
const SYMBOL_UNIT_KINDS = new Set(["function", "method", "class", "interface", "type"]);
/** ColGREP's own name for a raw, non-symbol chunk (`raw_code_<n>`) — never
 * eligible for name-first matching, even when `unitType` happens to claim a
 * symbol kind. */
const RAW_CHUNK_NAME_RE = /^raw_code_\d+$/;

/** Type-like ColGREP unit kinds treated as loosely interchangeable with each
 * other — a class/interface/type boundary can blur across languages and
 * extractors. Callable kinds (function/method) get NO such loosening: a
 * package-qualified top-level function's `qualified_name` (`"pkg.Fn"`) and a
 * receiver method's owner-qualified name (`"Receiver.Method"`) are
 * syntactically identical shapes, so a hit's `unitType` must never let a
 * method silently satisfy a function request or vice versa — only an EXACT
 * kind match qualifies there. */
const TYPE_UNIT_KINDS = new Set(["class", "interface", "type"]);

/** True when `nodeKind` is a plausible match for a hit's `unitType`: always
 * true for an exact kind match, or when both are in the loosely-interchangeable
 * type-like group (class/interface/type). Callable kinds (function/method)
 * have no such loosening (see `TYPE_UNIT_KINDS`). An unrecognized `unitType`
 * (outside `SYMBOL_UNIT_KINDS`, and not `nodeKind` itself) is never passed in,
 * but this stays permissive (true) for anything not covered rather than
 * silently rejecting every node. */
function unitTypeCompatible(nodeKind: string, unitType: string): boolean {
  if (nodeKind === unitType) return true;
  if (TYPE_UNIT_KINDS.has(unitType)) return TYPE_UNIT_KINDS.has(nodeKind);
  if (SYMBOL_UNIT_KINDS.has(unitType)) return false; // callable kinds: exact match only
  return true;
}

/** Derives the owner-qualified form `mapHitsToNodes` compares against a node
 * id's suffix from ColGREP's `qualified_name` — the last two dot-separated
 * segments (`"pkg.User.Save"` -> `"User.Save"`; `"User.Save"` stays as-is;
 * a bare `"Save"` also stays as-is). Package-qualified names (`pkg.Fn`) and
 * owner-qualified names (`Receiver.Method`) both end up in the same
 * `Owner.Member`-shaped form a node id's `#Owner.Member` suffix uses. */
function ownerQualifiedForm(qualifiedName: string): string {
  const parts = qualifiedName.split(".");
  return parts.length >= 2 ? parts.slice(-2).join(".") : qualifiedName;
}

/** Finds a symbol node (never a file node) in `candidates` whose id ends
 * `#<ownerQualifiedForm(qualifiedName)>` — ColGREP's most specific identity
 * for the unit, disambiguating e.g. two receivers' same-named methods
 * (`User.Save` vs `Order.Save`) that a bare name alone cannot.
 *
 * A package-qualified top-level function (`qualified_name: "services.ProcessWidget"`,
 * `unit_type: "function"`) and a receiver method's owner-qualified name
 * (`"services.ProcessWidget"` meaning receiver `services`, method
 * `ProcessWidget`) can produce the exact same `#<owner>` node-id suffix —
 * so this only returns a node whose kind is compatible with `unitType`
 * (`unitTypeCompatible`), preferring an EXACT kind match over a looser one
 * (relevant only for the type-like group; callable kinds never loosen — see
 * `unitTypeCompatible`). A suffix match of an incompatible kind is ignored
 * entirely (returns `null`), falling through to the bare-name step rather
 * than resolving to the wrong kind of symbol. */
function findByQualifiedName(candidates: NodeV1[], qualifiedName: string, unitType: string): NodeV1 | null {
  const owner = ownerQualifiedForm(qualifiedName);
  const suffix = `#${owner}`;
  let looseMatch: NodeV1 | null = null;
  for (const n of candidates) {
    if (n.kind === "file") continue;
    if (!n.id.endsWith(suffix)) continue;
    if (n.kind === unitType) return n;
    if (looseMatch === null && unitTypeCompatible(n.kind, unitType)) looseMatch = n;
  }
  return looseMatch;
}

/** Every symbol node (never a file node) in `candidates` whose name is
 * ColGREP's own unit identity for `name` — an exact `name` match, or a node
 * id ending `#${name}` / `.${name}` (owner-qualified forms like
 * `Cache#get`/`file.ts#Cache.get` reported as `"get"` or `"Cache.get"`) —
 * AND whose kind is compatible with `unitType` (see `unitTypeCompatible`). */
function findBareNameMatches(candidates: NodeV1[], name: string, unitType: string): NodeV1[] {
  const matches: NodeV1[] = [];
  for (const n of candidates) {
    if (n.kind === "file") continue;
    if (!unitTypeCompatible(n.kind, unitType)) continue;
    if (n.name === name || n.id.endsWith(`#${name}`) || n.id.endsWith(`.${name}`)) matches.push(n);
  }
  return matches;
}

/** Scores every candidate whose span overlaps `[hit.line, hit.endLine]` at
 * all by what fraction of the NODE's OWN span the overlap covers (ties broken
 * by the larger absolute overlap) and returns the best, or `null` when
 * nothing overlaps at all. Shared by the bare-name-ambiguity tiebreak (c) and
 * the whole-candidate-set fallback (d) in `mapHitsToNodes`. */
function bestBySpanOverlap(candidates: NodeV1[], hit: ColgrepHit): NodeV1 | null {
  let best: NodeV1 | null = null;
  let bestFraction = -1;
  let bestOverlap = -1;
  for (const n of candidates) {
    const parsed = parseSpan(n.span);
    if (!parsed) continue;
    const [a, b] = parsed;
    const overlapStart = Math.max(a, hit.line);
    const overlapEnd = Math.min(b, hit.endLine);
    if (overlapStart > overlapEnd) continue; // no overlap at all
    const overlap = overlapEnd - overlapStart + 1;
    const nodeWidth = b - a + 1;
    const fraction = nodeWidth > 0 ? overlap / nodeWidth : 0;
    if (fraction > bestFraction || (fraction === bestFraction && overlap > bestOverlap)) {
      best = n;
      bestFraction = fraction;
      bestOverlap = overlap;
    }
  }
  return best;
}

/** Maps each ColGREP hit onto the graph node that best matches it, falling
 * back to a synthetic `unindexed` candidate when the path isn't in the graph
 * at all. For every non-chunk hit, ColGREP's own unit identity is checked
 * FIRST, in order of specificity:
 *
 *  (a) `hit.qualifiedName`, when present, resolved against a node id's
 *      owner-qualified suffix (`findByQualifiedName`) — the most specific
 *      identity ColGREP can report, disambiguating e.g. two receivers'
 *      same-named methods (`User.Save` vs `Order.Save`) that a bare name
 *      alone cannot.
 *  (b) failing that (or absent), every bare-name match compatible with
 *      `hit.unitType` (`findBareNameMatches`) — if there's exactly one, it
 *      wins outright.
 *  (c) several bare-name matches (a genuine name collision with no
 *      `qualifiedName` to break it) — the one with the best span overlap
 *      with the hit, scored the same way as (d) below.
 *  (d) no name-first match at all (a raw chunk, an unnamed unit, or a
 *      name-first miss) — every candidate node (symbol or file) whose span
 *      OVERLAPS `[hit.line, hit.endLine]` at all is scored by what fraction
 *      of the NODE's OWN span the overlap covers (`bestBySpanOverlap`): a
 *      small function whose body is 90% covered by the hit wins over the
 *      whole file it lives in, while a `raw_code` chunk spanning an entire
 *      file scores 1.0 against the file itself and against any
 *      fully-contained symbol alike; ties are broken by the larger absolute
 *      overlap, which favors the file in that whole-file case (it explains
 *      more of the hit) and preserves "innermost wins" otherwise. This tier
 *      also catches ColGREP's chunk boundaries rarely lining up exactly with
 *      a symbol's own span (a doc comment above a function pulls `hit.line`
 *      a few lines earlier than the symbol's start) — containment of
 *      `hit.line` alone would be too strict and silently fall through to the
 *      file node for that common case.
 *
 * Dedupes by nodeId, keeping the highest score seen for a given node, while
 * preserving the order of each node's first occurrence (i.e. the colgrep
 * rank order). */
export function mapHitsToNodes(graph: GraphV1, hits: ColgrepHit[]): SearchCandidate[] {
  const nodesByPath = new Map<string, NodeV1[]>();
  for (const n of graph.nodes) {
    const list = nodesByPath.get(n.path);
    if (list) list.push(n);
    else nodesByPath.set(n.path, [n]);
  }

  const order: string[] = [];
  const byId = new Map<string, SearchCandidate>();

  for (const hit of hits) {
    const candidates = nodesByPath.get(hit.path);
    let chosen: SearchCandidate;

    if (!candidates || candidates.length === 0) {
      chosen = {
        nodeId: hit.path,
        path: hit.path,
        span: `L${hit.line}-L${hit.endLine}`,
        name: hit.name,
        kind: null,
        signature: null,
        provenance: "colgrep",
        rrf: hit.score,
        ranks: {},
        unindexed: true,
        colgrepMatch: null,
      };
    } else {
      const isRawChunk = RAW_CHUNK_NAME_RE.test(hit.name);
      let node: NodeV1 | null = null;
      let colgrepMatch: SearchCandidate["colgrepMatch"] = null;

      if (!isRawChunk && SYMBOL_UNIT_KINDS.has(hit.unitType)) {
        if (hit.qualifiedName) {
          node = findByQualifiedName(candidates, hit.qualifiedName, hit.unitType);
          if (node) colgrepMatch = "symbol";
        }
        if (!node) {
          const bareMatches = findBareNameMatches(candidates, hit.name, hit.unitType);
          if (bareMatches.length === 1) {
            node = bareMatches[0];
            colgrepMatch = "symbol";
          } else if (bareMatches.length > 1) {
            node = bestBySpanOverlap(bareMatches, hit);
            if (node) colgrepMatch = "symbol";
          }
        }
      }

      if (!node) {
        node = bestBySpanOverlap(candidates, hit);
        if (node) colgrepMatch = node.kind === "file" ? "file" : "chunk";
      }

      if (node) {
        chosen = {
          nodeId: node.id,
          path: node.path,
          span: node.span,
          name: node.name,
          kind: node.kind,
          signature: node.signature,
          provenance: "colgrep",
          rrf: hit.score,
          ranks: {},
          colgrepMatch,
        };
      } else {
        // Path is in the graph but nothing (symbol or file) matched — treat
        // like an unindexed hit rather than silently dropping it.
        chosen = {
          nodeId: hit.path,
          path: hit.path,
          span: `L${hit.line}-L${hit.endLine}`,
          name: hit.name,
          kind: null,
          signature: null,
          provenance: "colgrep",
          rrf: hit.score,
          ranks: {},
          unindexed: true,
          colgrepMatch: null,
        };
      }
    }

    const existing = byId.get(chosen.nodeId);
    if (!existing) {
      order.push(chosen.nodeId);
      byId.set(chosen.nodeId, chosen);
    } else if (hit.score > existing.rrf) {
      byId.set(chosen.nodeId, { ...chosen, rrf: hit.score });
    }
  }

  return order.map((id) => byId.get(id)!);
}

// Deliberately generic — this ships to every Graft user, and `tools/`/`mocks/`
// hold real production code in many repos (not just this one), so neither is
// a default test segment here. `__mocks__` stays (a Jest-family convention
// unambiguous enough to default on); a bare `mocks` dir is not.
const TEST_SEGMENT_NAMES = new Set(["test", "tests", "__tests__", "__mocks__", "e2e", "testdata", "fixtures", "spec"]);
const TEST_FILE_RE = /\.(test|spec|stories)\./i;
const TEST_SUFFIX_RE = /_test\.(go|ts)$/i;

/** True for `*.test.*`/`*.spec.*`/`*.stories.*` files, `*_test.go`/`*_test.ts`
 * files, or any path segment named
 * `test`/`tests`/`__tests__`/`__mocks__`/`e2e`/`testdata`/`fixtures`/`spec`
 * (case-insensitive, whole segment only). */
export function isTestPath(path: string): boolean {
  if (TEST_FILE_RE.test(path)) return true;
  if (TEST_SUFFIX_RE.test(path)) return true;
  const segments = path.split("/");
  for (const seg of segments) {
    if (TEST_SEGMENT_NAMES.has(seg.toLowerCase())) return true;
  }
  return false;
}

/** Standard reciprocal rank fusion: for each list, rank starts at 1 and each
 * item's score gets `1/(k + rank)` added. A nodeId repeated within one list
 * is only counted once, at its first (best) occurrence — rank numbering for
 * the rest of that list is compacted around the dropped duplicate, as if it
 * had never been there — so a caller that hasn't already deduped its own
 * list can never double-count one node's agreement. Returns a map from
 * nodeId to the summed score plus the per-source rank it held (1-based). */
export function rrfFuse(
  lists: { source: "ask" | "semantic"; items: { nodeId: string }[] }[],
  k = 60,
): Map<string, { rrf: number; ranks: Record<string, number> }> {
  const result = new Map<string, { rrf: number; ranks: Record<string, number> }>();
  for (const list of lists) {
    const seen = new Set<string>();
    let rank = 0;
    for (const item of list.items) {
      if (seen.has(item.nodeId)) continue;
      seen.add(item.nodeId);
      rank += 1;
      const entry = result.get(item.nodeId) ?? { rrf: 0, ranks: {} };
      entry.rrf += 1 / (k + rank);
      entry.ranks[list.source] = rank;
      result.set(item.nodeId, entry);
    }
  }
  return result;
}

/** Internal-only ablation switches for measuring `fuseSearch`/`ask` design
 * choices against alternatives (see `scripts/eval-search.mjs`). Never exposed
 * on the CLI or MCP surface — `@internal`. Every field's default reproduces
 * exactly today's behavior, so an omitted `_ablation` (or an explicitly
 * empty `{}`) is byte-identical to code with no `_ablation` concept at all. */
export interface SearchAblation {
  /** How a colgrep FILE candidate that re-keys onto an ask SYMBOL hit for the
   * same path is placed. `"tier1b"` (default): current behavior — the
   * re-keyed node is tagged `same-file` and ranked in tier 1b, above tier 2.
   * `"tier2"`: it keeps provenance `same-file` but is NOT placed in tier 1b;
   * instead it joins the ask-only list at its own ask rank (subject to
   * `askOnlyRankCap` exactly like any other ask-only node) and takes part in
   * normal tier-2 alternation. `"off"`: the file→symbol re-key never
   * happens at all — colgrep file candidates stay file nodes, and provenance
   * follows the normal rules (`both` only when `ask` independently returned
   * that same file node; `survivorWasReKeyed` is then always false). */
  sameFile?: "tier1b" | "tier2" | "off";
  /** `"tiered"` (default): the union-preserving tier 1 / tier 1b / tier-2
   * alternation order `fuseSearch` normally renders. `"rrf"`: after building
   * the fused candidate set and applying `askOnlyRankCap` (ask-only nodes
   * whose ask rank exceeds it are dropped; nodes present in both lists and
   * colgrep-only nodes are never dropped), returns every remaining candidate
   * sorted by rrf desc, nodeId asc — no tiers. Provenance tags are
   * unaffected either way. */
  ordering?: "tiered" | "rrf";
  /** Forwarded to `ask()`'s own `graphRank` option (default true there) —
   * `fuseSearch` itself never reads this field; `search()` passes it through
   * to the internal `ask()` call. Declared here purely so one `_ablation`
   * object can carry every search-time ablation switch together. */
  graphRank?: boolean;
}

export interface FuseSearchOptions {
  askHits: AskSearchHit[];
  semantic: SearchCandidate[];
  includeTests?: boolean;
  limit?: number;
  k?: number;
  /** Caps tier-2 ask-ONLY candidates to those whose ask rank is at or below
   * this value; unset means no cap. Lets a caller fetch `ask` far past the
   * display limit purely to widen agreement (`both`) detection, without that
   * wider fetch also flooding tier 2 with low-confidence ask-only guesses —
   * a node present in BOTH lists (tier 1) is exempt: agreement is the
   * strongest signal there is and must never be capped away by a display
   * limit. Semantic-only candidates are unaffected. */
  askOnlyRankCap?: number;
  /** Internal-only ablation switches (see {@link SearchAblation}), never
   * exposed on the CLI or MCP. Omitted (or `{}`) reproduces today's
   * behavior exactly. @internal */
  _ablation?: SearchAblation;
}

/** Filters test/tools paths (unless `includeTests`), reciprocal-rank-fuses
 * the `ask` and semantic lists, merges metadata (ask hit metadata wins for a
 * node present in both), tags provenance, and renders a union-preserving
 * final order (see below) rather than a plain rrf-desc sort. `rrf`/`ranks`
 * are still populated on every result for `--json` consumers.
 *
 * Before fusing, re-keys a colgrep FILE candidate onto the best-ranked ask
 * SYMBOL hit for that same path, when one exists — ColGREP whole-file chunks
 * and `ask`'s own symbol resolution otherwise land as two separate
 * candidates (a `colgrep` file plus a `lexical` symbol) for what is really
 * one answer; this merges them into a single result instead, tagged
 * `same-file` rather than `both` (see `Provenance` — a file-level re-key is
 * real signal but not the node-level agreement `both` promises). Only the
 * best-ranked ask symbol for a shared file is credited when several exist.
 * After re-keying, the colgrep list is deduped by nodeId (keeping the
 * earliest/best-ranked occurrence) before it reaches `rrfFuse`, so re-keying
 * two originally-distinct colgrep candidates onto the same nodeId (a
 * function-level hit plus a whole-file chunk from the same file, say) can
 * never double-count that node's agreement.
 *
 * Final ordering policy (union-preserving merge, not pure RRF): a 5-slot
 * answer must carry each retriever's top hits, because `ask` and ColGREP
 * miss different questions — pure RRF lets a strong lexical list bury a
 * colgrep-only answer (or vice versa) under sheer rank-sum even when the
 * buried hit is the correct one. Tier 1 is every candidate both retrievers
 * agree on at the node level (provenance `both`), the strongest possible
 * signal, ordered by rrf desc (nodeId asc breaks ties). Tier 1b is every
 * `same-file` candidate, same ordering, ranked below tier 1 but still above
 * tier 2. Tier 2 alternates the remaining ask-only and semantic-only
 * candidates by their OWN list rank (ask rank 1, semantic rank 1, ask rank
 * 2, semantic rank 2, …), starting with whichever list has the better
 * (lower) top remaining rank — ties go to ask — so each retriever's best
 * remaining guesses get a guaranteed slot near the top instead of being
 * crowded out by the other list's volume. */
export function fuseSearch(opts: FuseSearchOptions): SearchCandidate[] {
  const includeTests = opts.includeTests ?? false;
  const limit = opts.limit ?? 10;
  const ablation = opts._ablation ?? {};
  const sameFileMode = ablation.sameFile ?? "tier1b";
  const ordering = ablation.ordering ?? "tiered";

  const askHits = includeTests ? opts.askHits : opts.askHits.filter((h) => !isTestPath(h.path));
  const rawSemantic = includeTests ? opts.semantic : opts.semantic.filter((h) => !isTestPath(h.path));

  const bestAskSymbolIndexByPath = new Map<string, number>();
  askHits.forEach((h, idx) => {
    if (!h.kind || h.kind === "file") return;
    if (!bestAskSymbolIndexByPath.has(h.path)) bestAskSymbolIndexByPath.set(h.path, idx);
  });

  // Re-key file candidates onto their path's best ask symbol, tracking —
  // per resulting nodeId — whether the occurrence that will SURVIVE the
  // dedup below (the earliest/best-ranked one) was itself produced by this
  // re-key. That, not "was ANY occurrence re-keyed", is what decides
  // `same-file` vs true `both` next: a later re-keyed duplicate of an
  // already-genuine node-level match must never downgrade real agreement.
  const survivorWasReKeyed = new Map<string, boolean>();
  const reKeyedSemantic: SearchCandidate[] = [];
  for (const s of rawSemantic) {
    let item = s;
    let wasReKeyed = false;
    if (sameFileMode !== "off" && s.kind === "file") {
      const bestIdx = bestAskSymbolIndexByPath.get(s.path);
      if (bestIdx !== undefined) {
        item = { ...s, nodeId: askHits[bestIdx].nodeId, colgrepMatch: s.colgrepMatch ?? "file" };
        wasReKeyed = true;
      }
    }
    reKeyedSemantic.push(item);
    if (!survivorWasReKeyed.has(item.nodeId)) survivorWasReKeyed.set(item.nodeId, wasReKeyed);
  }

  // Dedupe by nodeId AFTER re-keying, keeping the earliest (best) semantic
  // rank, before this list ever reaches `rrfFuse`.
  const seenSemanticIds = new Set<string>();
  const semantic: SearchCandidate[] = [];
  for (const s of reKeyedSemantic) {
    if (seenSemanticIds.has(s.nodeId)) continue;
    seenSemanticIds.add(s.nodeId);
    semantic.push(s);
  }

  const askById = new Map<string, AskSearchHit>();
  for (const h of askHits) if (!askById.has(h.nodeId)) askById.set(h.nodeId, h);
  const semanticById = new Map<string, SearchCandidate>();
  for (const h of semantic) if (!semanticById.has(h.nodeId)) semanticById.set(h.nodeId, h);

  const fused = rrfFuse(
    [
      { source: "ask", items: askHits.map((h) => ({ nodeId: h.nodeId })) },
      { source: "semantic", items: semantic.map((h) => ({ nodeId: h.nodeId })) },
    ],
    opts.k,
  );

  const byId = new Map<string, SearchCandidate>();
  for (const [nodeId, { rrf, ranks }] of fused) {
    const inAsk = askById.get(nodeId);
    const inSemantic = semanticById.get(nodeId);

    let provenance: Provenance;
    if (inAsk && inSemantic) provenance = survivorWasReKeyed.get(nodeId) ? "same-file" : "both";
    else if (inSemantic) provenance = "colgrep";
    else if (inAsk?.fromGraph) provenance = "graph";
    else provenance = "lexical";

    // Ask hit metadata wins when a node is present in both lists.
    const meta = inAsk ?? inSemantic!;
    const unindexed = inSemantic?.unindexed;

    byId.set(nodeId, {
      nodeId,
      path: meta.path,
      span: meta.span,
      name: meta.name,
      kind: meta.kind ?? null,
      signature: meta.signature ?? null,
      provenance,
      rrf,
      ranks: { ask: ranks.ask, semantic: ranks.semantic },
      colgrepMatch: inSemantic?.colgrepMatch ?? null,
      ...(unindexed ? { unindexed: true } : {}),
    });
  }

  const byRrfDescThenNodeIdAsc = (a: SearchCandidate, b: SearchCandidate): number =>
    b.rrf !== a.rrf ? b.rrf - a.rrf : a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;

  // `_ablation.ordering: "rrf"` — after the ask-only rank cap (ask-only nodes
  // whose ask rank exceeds it are dropped; `both`/colgrep-only nodes are
  // never dropped), sort every remaining candidate by rrf desc, nodeId asc.
  // No tiers; provenance tags are unaffected. Under `_ablation.sameFile:
  // "tier2"`, a `same-file` node is placed in the ask-only alternation list
  // (see tier 2 below) and so must be subject to the same ask-rank cap here
  // too — under the default/"off" sameFile modes it keeps its own placement
  // and is never capped by this filter.
  if (ordering === "rrf") {
    const kept = [...byId.values()].filter((r) => {
      const isAskOnly = r.provenance === "lexical" || r.provenance === "graph";
      const isCappedSameFile = sameFileMode === "tier2" && r.provenance === "same-file";
      if (!isAskOnly && !isCappedSameFile) return true;
      if (opts.askOnlyRankCap === undefined) return true;
      const askRank = r.ranks.ask;
      return askRank === undefined || askRank <= opts.askOnlyRankCap;
    });
    return kept.sort(byRrfDescThenNodeIdAsc).slice(0, limit);
  }

  // Tier 1: every candidate both retrievers agree on at the node level.
  const tier1 = [...byId.values()].filter((r) => r.provenance === "both").sort(byRrfDescThenNodeIdAsc);
  // Tier 1b: same-file re-key agreement — real signal, ranked below true
  // node-level agreement but still above tier 2. Under `_ablation.sameFile:
  // "tier2"`, same-file candidates are excluded here entirely — they join
  // the ask-only list at their own ask rank below instead.
  const tier1b =
    sameFileMode === "tier2"
      ? []
      : [...byId.values()].filter((r) => r.provenance === "same-file").sort(byRrfDescThenNodeIdAsc);

  // Tier 2 source lists: the remaining ask-only and semantic-only nodeIds,
  // each already in that list's own rank order (askHits/semantic are
  // rank-ordered inputs), deduped to first occurrence.
  const askOnlyIds: string[] = [];
  {
    const seen = new Set<string>();
    for (const h of askHits) {
      if (seen.has(h.nodeId)) continue;
      const cand = byId.get(h.nodeId);
      if (semanticById.has(h.nodeId)) {
        // Under "tier2", a same-file node is deliberately treated as
        // ask-only for placement purposes even though it's also present in
        // `semanticById` — everything else present in both lists (true
        // `both` agreement, or same-file under the default/"off" modes,
        // which are placed elsewhere) stays excluded here.
        const includeSameFileAsAskOnly = sameFileMode === "tier2" && cand?.provenance === "same-file";
        if (!includeSameFileAsAskOnly) continue;
      }
      seen.add(h.nodeId);
      const askRank = cand?.ranks.ask;
      if (opts.askOnlyRankCap !== undefined && askRank !== undefined && askRank > opts.askOnlyRankCap) continue;
      askOnlyIds.push(h.nodeId);
    }
  }
  const semanticOnlyIds: string[] = [];
  {
    const seen = new Set<string>();
    for (const s of semantic) {
      if (askById.has(s.nodeId) || seen.has(s.nodeId)) continue;
      seen.add(s.nodeId);
      semanticOnlyIds.push(s.nodeId);
    }
  }

  const askTopRank = askOnlyIds.length ? byId.get(askOnlyIds[0])!.ranks.ask! : Infinity;
  const semanticTopRank = semanticOnlyIds.length ? byId.get(semanticOnlyIds[0])!.ranks.semantic! : Infinity;
  const startWithAsk = askTopRank <= semanticTopRank; // tie -> ask first

  const tier2Ids: string[] = [];
  {
    let i = 0;
    let j = 0;
    let takeAsk = startWithAsk;
    while (i < askOnlyIds.length || j < semanticOnlyIds.length) {
      if (takeAsk) {
        if (i < askOnlyIds.length) tier2Ids.push(askOnlyIds[i++]);
        else tier2Ids.push(semanticOnlyIds[j++]);
      } else {
        if (j < semanticOnlyIds.length) tier2Ids.push(semanticOnlyIds[j++]);
        else tier2Ids.push(askOnlyIds[i++]);
      }
      takeAsk = !takeAsk;
    }
  }

  const results = [...tier1, ...tier1b, ...tier2Ids.map((id) => byId.get(id)!)];

  return results.slice(0, limit);
}

/** The first line of a (possibly multi-line) signature string, truncated so a
 * five-hit answer stays near the ≈200-token budget; the full signature is one
 * `graft skeleton` away and the `--json` form is untouched. */
const SIGNATURE_RENDER_MAX = 72;
function firstLineOf(s: string | null): string | null {
  if (!s) return null;
  const first = s.split("\n")[0].trim();
  return first.length > SIGNATURE_RENDER_MAX ? `${first.slice(0, SIGNATURE_RENDER_MAX - 1)}…` : first;
}

/** Renders results either as a single-line JSON payload (`--json`) or as a
 * compact ≈30-token-per-hit text listing, plus a trailing note line when
 * given. */
export function renderSearch(results: SearchCandidate[], opts: { json?: boolean; note?: string } = {}): string {
  if (opts.json) {
    return JSON.stringify({ results, note: opts.note }, null, 0);
  }
  const lines = results.map((r, i) => {
    const sig = firstLineOf(r.signature) ?? r.kind ?? "";
    const suffix = r.unindexed ? " (unindexed)" : "";
    return `${i + 1}. ${r.path}:${r.span ?? "-"} · ${r.name} · ${sig} · [${r.provenance}]${suffix}`;
  });
  if (opts.note) lines.push(opts.note);
  return lines.join("\n");
}
