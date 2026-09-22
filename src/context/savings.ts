/**
 * Baseline-size metadata retained for compatibility and internal measurement.
 * Graft no longer renders "tokens saved" claims into retrieval output because
 * the whole-file baseline does not represent normal agent behavior.
 */
import type { GraphV1 } from '../graph/types.js';

export interface Savings {
  files: number;
  baselineChars: number;
}

export function toTokens(chars: number): number {
  return Math.round(chars / 4);
}

function fileSizes(graph: GraphV1): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of graph.nodes)
    if (n.kind === 'file' && typeof n.chars === 'number') m.set(n.path, n.chars);
  return m;
}

export function savingsFor(graph: GraphV1, paths: Iterable<string>): Savings | undefined {
  const sizes = fileSizes(graph);
  let baselineChars = 0;
  let files = 0;
  for (const p of new Set(paths)) {
    const c = sizes.get(p);
    if (c === undefined) continue;
    baselineChars += c;
    files++;
  }
  return files > 0 ? { files, baselineChars } : undefined;
}

/** Legacy API retained so existing CLI/MCP callers need no coordination. */
export function setInputRate(_usdPerMtok: number | null): void {}

/** No user-facing savings nudge: the audited baseline is not a real-world saving. */
export function savingsTurnNudge(_savedTokens: number): string {
  return '';
}

/** Savings claims are intentionally suppressed from tool output. */
export function savingsLine(_body: string, _saved: Savings | undefined): string {
  return '';
}

/** Parse historical footers for backwards-compatible telemetry/imports. */
export function sumSavingsFooters(text: string): number {
  let total = 0;
  for (const m of text.matchAll(/\[graft\] tokens saved ≈ ([\d,]+)/g)) {
    total += Number(m[1].replace(/,/g, '')) || 0;
  }
  return total;
}

/** Retrieval output is now the useful body only. */
export function withSavings(body: string, _saved: Savings | undefined): string {
  return body;
}
