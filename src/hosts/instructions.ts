/**
 * The one canonical Graft instruction block, rendered into each host's
 * native format. Content changes happen HERE only; renderers just wrap it.
 */

export function instructionBody(): string {
  return `## Graft — structural repo map

Use Graft selectively for structural questions: callers/callees, blast radius,
file API/skeletons, dependency topology, and unfamiliar architecture.

- \`graft callers <symbol>\` traces relationships; add \`--direction out\` for
  outgoing dependencies or \`--depth N\` for transitive blast-radius exploration.
- \`graft skeleton <file>\` gives a compact API/signature view of a known file.
- \`graft ask "<question>" --source\` helps with unfamiliar conceptual or architectural areas.
- \`graft map\` orients you in an unfamiliar repository.
- \`graft grep "<pattern>"\` is useful when grouped indexed search helps.

For a known file, symbol, literal, RPC id, type, store, or other direct lookup,
go straight to source, \`rg\`, or LSP/reference search. Do not put a Graft call
in front of an obviously direct lookup.

Graft is navigation evidence, not authoritative truth. \`ask\` is ranked top-N,
call edges may include inferred relationships, and source excerpts can be incomplete.
Read authoritative source before editing and independently verify critical references
for high-risk work. Compiler/typechecker results, tests, runtime behavior, and
authoritative specifications decide correctness.`;
}

export function cursorRule(): string {
  return `---
description: Use Graft selectively for structural repository questions
alwaysApply: true
---
${instructionBody()}
`;
}

export function kiroSteering(): string {
  return `---
inclusion: always
---
${instructionBody()}
`;
}

export function windsurfRule(): string {
  return `${instructionBody()}
`;
}
