/** Tests for retained baseline metadata with agent-facing savings claims disabled. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savingsFor, savingsLine, savingsTurnNudge, sumSavingsFooters, withSavings, setInputRate } from '../src/context/savings.js';
import type { GraphV1, NodeV1 } from '../src/graph/types.js';

function fileNode(path: string, chars?: number): NodeV1 {
  return {
    id: path, name: path, kind: 'file', path, span: 'L1-L1', signature: null,
    exported: true, origin: 'ast', body_hash: '', summary_state: 'pending',
    summary: null, crux: null, chars,
  };
}

function graphOf(nodes: NodeV1[]): GraphV1 {
  return { meta: { version: 1, nodeCount: nodes.length, edgeCount: 0, languages: [] }, nodes, edges: [] };
}

test('savingsFor still records distinct baseline file sizes for compatibility', () => {
  const g = graphOf([fileNode('a.ts', 400), fileNode('b.ts', 600)]);
  assert.deepEqual(savingsFor(g, ['a.ts', 'b.ts', 'a.ts']), { files: 2, baselineChars: 1000 });
});

test('savingsFor skips files with no known size', () => {
  const g = graphOf([fileNode('a.ts'), fileNode('b.ts', 800)]);
  assert.deepEqual(savingsFor(g, ['a.ts', 'b.ts']), { files: 1, baselineChars: 800 });
  assert.equal(savingsFor(graphOf([fileNode('a.ts')]), ['a.ts']), undefined);
});

test('agent-facing savings line and nudge are always suppressed', () => {
  setInputRate(5);
  assert.equal(savingsLine('body', { files: 2, baselineChars: 8000 }), '');
  assert.equal(savingsTurnNudge(1000), '');
  setInputRate(null);
});

test('withSavings returns retrieval content byte-for-byte', () => {
  const body = 'line1\nline2\nline3';
  assert.equal(withSavings(body, { files: 2, baselineChars: 8000 }), body);
  assert.equal(withSavings(body, undefined), body);
});

test('legacy savings footers can still be parsed for old logs', () => {
  assert.equal(sumSavingsFooters('[graft] tokens saved ≈ 1,200\n[graft] tokens saved ≈ 30'), 1230);
});
