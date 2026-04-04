import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { ComponentPopulated } from '../algorithms/types';
import { ConsumerResult, cycleFlatProbe, naiveJsonProbe } from './consumer';

const ANALYSIS_DIR = path.resolve(__dirname, '..', '..', 'analysis');

// ---------------------------------------------------------------------------
// Helpers — build small, controlled cyclic / acyclic graphs by hand
// ---------------------------------------------------------------------------

function makeNode(id: string): ComponentPopulated {
  return { id, dependencies: [] };
}

/** Linear: a → b (no cycle) */
function linearPair(): ComponentPopulated[] {
  const a = makeNode('a');
  const b = makeNode('b');
  a.dependencies.push(b);
  return [a, b];
}

/** 2-node cycle: a → b → a */
function twoCycle(): ComponentPopulated[] {
  const a = makeNode('a');
  const b = makeNode('b');
  a.dependencies.push(b);
  b.dependencies.push(a);
  return [a, b];
}

/** Diamond: a→b, a→c, b→d, c→d (d is a shared reference) */
function diamond(): ComponentPopulated[] {
  const a = makeNode('a');
  const b = makeNode('b');
  const c = makeNode('c');
  const d = makeNode('d');
  a.dependencies.push(b, c);
  b.dependencies.push(d);
  c.dependencies.push(d); // same d object — shared reference
  return [a, b, c, d];
}

/** Self-referential chain: 0→1→2→...→(n-1)→0 */
function makeChainCycle(n: number): ComponentPopulated[] {
  const nodes: ComponentPopulated[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push(makeNode(`node_${i}`));
  }
  for (let i = 0; i < n; i++) {
    nodes[i].dependencies.push(nodes[(i + 1) % n]);
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// naiveJsonProbe — input validation
// ---------------------------------------------------------------------------

describe('naiveJsonProbe — input handling', () => {
  it('passes on an empty graph', () => {
    const r = naiveJsonProbe.consume([]);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('passes on an acyclic linear graph', () => {
    const r = naiveJsonProbe.consume(linearPair());
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('passes on an acyclic diamond graph (shared reference, no cycle)', () => {
    // diamond() has a shared reference (d) but no cycle — JSON.stringify succeeds
    // because it only detects actual back-edge cycles, not DAG shared references.
    const r = naiveJsonProbe.consume(diamond());
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });
});

describe('naiveJsonProbe — cyclic graph detection', () => {
  it('fails on a 2-node cycle (a → b → a)', () => {
    const r = naiveJsonProbe.consume(twoCycle());
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null);
    // The standard error message from V8 JSON.stringify on circular structures
    assert.ok(
      r.errorDetail.toLowerCase().includes('circular') ||
        r.errorDetail.toLowerCase().includes('cyclic') ||
        r.errorDetail.toLowerCase().includes('json'),
      `Expected circular/cyclic/json error, got: ${r.errorDetail}`,
    );
  });

  it('fails on a self-referential 20-node chain cycle', () => {
    const r = naiveJsonProbe.consume(makeChainCycle(20));
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null);
  });

  it('does not mutate the graph nodes', () => {
    const nodes = twoCycle();
    const depCountBefore = nodes[0].dependencies.length;
    naiveJsonProbe.consume(nodes);
    assert.equal(nodes[0].dependencies.length, depCountBefore);
  });
});

// ---------------------------------------------------------------------------
// cycleFlatProbe — acyclic graphs
// ---------------------------------------------------------------------------

describe('cycleFlatProbe — acyclic graphs', () => {
  it('passes on an empty graph', () => {
    const r = cycleFlatProbe.consume([]);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('passes on a single node with no dependencies', () => {
    const r = cycleFlatProbe.consume([makeNode('solo')]);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('passes on an acyclic linear pair', () => {
    const r = cycleFlatProbe.consume(linearPair());
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('passes on a diamond graph with a shared-reference node', () => {
    const r = cycleFlatProbe.consume(diamond());
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });
});

// ---------------------------------------------------------------------------
// cycleFlatProbe — cyclic graphs
// ---------------------------------------------------------------------------

describe('cycleFlatProbe — cyclic graphs', () => {
  it('passes on a 2-node cycle (cycle-safe by construction)', () => {
    const r = cycleFlatProbe.consume(twoCycle());
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('passes on a long chain-cycle (20 nodes)', () => {
    const r = cycleFlatProbe.consume(makeChainCycle(20));
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('does not mutate the graph nodes', () => {
    const nodes = twoCycle();
    const depCountBefore = nodes[0].dependencies.length;
    cycleFlatProbe.consume(nodes);
    assert.equal(nodes[0].dependencies.length, depCountBefore);
  });
});

// ---------------------------------------------------------------------------
// cycleFlatProbe — orphaned dependency detection
// ---------------------------------------------------------------------------

describe('cycleFlatProbe — orphaned dependency detection', () => {
  it('fails when a dependency object is not in the top-level array', () => {
    const a = makeNode('a');
    const orphan = makeNode('orphan'); // not included in the top-level array
    a.dependencies.push(orphan);

    const r = cycleFlatProbe.consume([a]); // orphan is missing from array
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null);
    assert.ok(r.errorDetail.includes('orphan') || r.errorDetail.includes('not present'));
  });
});

// ---------------------------------------------------------------------------
// Contrast: naiveJsonProbe vs cycleFlatProbe on the same cyclic graph
// (This is the core demonstration of the two-stage paradigm: hydration success
//  does not guarantee consumer viability for naive consumers.)
// ---------------------------------------------------------------------------

describe('consumer probe contrast — hydration success ≠ naive-json viability', () => {
  it('naiveJsonProbe fails on a 2-cycle while cycleFlatProbe passes — same graph', () => {
    const graph = twoCycle();

    const naiveResult: ConsumerResult = naiveJsonProbe.consume(graph);
    const flatResult: ConsumerResult = cycleFlatProbe.consume(graph);

    // naive-json cannot handle the cyclic graph
    assert.equal(naiveResult.pass, false, 'naiveJsonProbe should fail on cyclic graph');
    assert.ok(naiveResult.errorDetail !== null);

    // cycle-flat handles the same graph without issue
    assert.equal(flatResult.pass, true, 'cycleFlatProbe should pass on cyclic graph');
    assert.equal(flatResult.errorDetail, null);

    // Write trace log for auditing
    fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
    const tracePath = path.join(ANALYSIS_DIR, 'consumer-probe-trace.log');
    const logLines = [
      '=== Consumer probe contrast — 2-node cycle (a → b → a) ===',
      '',
      `naive-json  : pass=${naiveResult.pass}, error="${String(naiveResult.errorDetail)}"`,
      `cycle-flat  : pass=${flatResult.pass}, error="${String(flatResult.errorDetail)}"`,
      '',
      'Interpretation:',
      '  A graph that was correctly hydrated (all object references intact) still',
      '  crashes a naive JSON.stringify consumer. The cycle-flat probe succeeds on',
      '  the same graph by using an iterative index-based export — no recursion,',
      '  no circular reference errors.',
    ];
    fs.writeFileSync(tracePath, logLines.join('\n') + '\n', 'utf8');
  });

  it('naiveJsonProbe passes and cycleFlatProbe passes on an acyclic graph — both succeed', () => {
    const graph = linearPair();

    const naiveResult = naiveJsonProbe.consume(graph);
    const flatResult = cycleFlatProbe.consume(graph);

    assert.equal(naiveResult.pass, true, 'naiveJsonProbe should pass on acyclic graph');
    assert.equal(flatResult.pass, true, 'cycleFlatProbe should pass on acyclic graph');
  });
});
