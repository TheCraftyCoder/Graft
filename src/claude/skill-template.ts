// The graft Claude Code skill, bundled as a string so `graft init` can write it into a
// consumer repo's .claude/skills/graft/SKILL.md (no network fetch, version-locked to the
// installed graft). This is the single source of truth for the skill text.
export function skillTemplate(): string {
  return `---
name: graft
description: Use Graft selectively for structural repository questions such as callers, blast radius, file APIs, dependency topology, and unfamiliar architecture.
---

# Graft

Graft is a structural repository map. Use it when relationships or architecture
matter; do not use it merely because it exists.

## Choose the shortest path

- Known file, symbol, literal, RPC id, type, or store:
  use source, \`rg\`, or LSP/reference search directly.
- Callers/callees or blast radius:
  \`graft callers <symbol>\`
  - default: incoming callers/references
  - \`--direction out\`: outgoing dependencies/callees
  - \`--depth N\`: transitive structural exploration
- API/signatures of a known file: \`graft skeleton <file>\`
- Unfamiliar conceptual or architectural region: \`graft ask "<question>" --source\`
- High-level unfamiliar repository orientation: \`graft map\`
- Grouped indexed search: \`graft grep "<pattern>"\`

## Evidence rules

Graft is navigation evidence, not authoritative truth.

- \`ask\` is ranked top-N, not exhaustive.
- Call graph relationships may include inferred edges.
- A source excerpt may not contain the whole definition.
- Read authoritative source before editing.
- For high-risk changes, independently verify critical producers, consumers,
  serialization boundaries, and callers with deterministic search, LSP, or compiler evidence.
- Tests, compiler/typechecker results, runtime behavior, and authoritative
  specifications decide correctness.

Graft tools refresh the structural graph before answering. Do not report, tally,
or rely on Graft's estimated "tokens saved" figures.

When MCP is connected, equivalent tools include \`graft_find_code\`,
\`graft_find_all\`, \`graft_file_api\`, \`graft_trace_calls\`,
\`graft_repo_map\`, and \`graft_check_freshness\`.
`;
}
