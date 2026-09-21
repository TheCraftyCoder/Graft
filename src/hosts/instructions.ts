/**
 * The one canonical Graft instruction block, rendered into each host's
 * native format. Content changes happen HERE only; renderers just wrap it.
 */

/** Minimal always-on pointer. The full workflow lives in the on-demand skill. */
export function instructionHint(): string {
  return `## Graft

For structural repository navigation, use the on-demand \`graft\` skill. For
known files, symbols, literals, RPC ids, types, or stores, use source, \`rg\`,
or LSP directly. Treat Graft as navigation evidence; verify source before editing.`;
}

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
description: Compatibility pointer for Graft structural navigation; prefer the on-demand graft skill.
alwaysApply: false
---
${instructionHint()}
`;
}

export function kiroSteering(): string {
  return `---
inclusion: manual
---
${instructionHint()}
`;
}

export function windsurfRule(): string {
  return `---
trigger: manual
---
${instructionHint()}
`;
}
