import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ComponentPopulated } from '../algorithms/types';
import { smartCompare } from './compare';

// ---------------------------------------------------------------------------
// Helpers — build small, controlled cyclic / acyclic graphs by hand
// ---------------------------------------------------------------------------

function makeNode(id: string, name?: string): ComponentPopulated {
  return { id, name: name ?? `Component ${id}`, dependencies: [] };
}

// A → B (no cycle)
function linearPair(): [ComponentPopulated[], ComponentPopulated[]] {
  const a1 = makeNode('a');
  const b1 = makeNode('b');
  a1.dependencies.push(b1);

  const a2 = makeNode('a');
  const b2 = makeNode('b');
  a2.dependencies.push(b2);

  return [[a1, b1], [a2, b2]];
}

// A → B → A (simple 2-node cycle using shared object references)
function twoCycle(): [ComponentPopulated[], ComponentPopulated[]] {
  const a1 = makeNode('a');
  const b1 = makeNode('b');
  a1.dependencies.push(b1);
  b1.dependencies.push(a1); // cycle: b1 → a1

  const a2 = makeNode('a');
  const b2 = makeNode('b');
  a2.dependencies.push(b2);
  b2.dependencies.push(a2);

  return [[a1, b1], [a2, b2]];
}

// Diamond: A→B, A→C, B→D, C→D  (D is a shared node referenced twice)
function diamond(): [ComponentPopulated[], ComponentPopulated[]] {
  const a1 = makeNode('a');
  const b1 = makeNode('b');
  const c1 = makeNode('c');
  const d1 = makeNode('d');
  a1.dependencies.push(b1, c1);
  b1.dependencies.push(d1);
  c1.dependencies.push(d1); // same d1 object — shared reference

  const a2 = makeNode('a');
  const b2 = makeNode('b');
  const c2 = makeNode('c');
  const d2 = makeNode('d');
  a2.dependencies.push(b2, c2);
  b2.dependencies.push(d2);
  c2.dependencies.push(d2);

  return [[a1, b1, c1, d1], [a2, b2, c2, d2]];
}

// Self-referential chain: 0→1→2→...→(n-1)→0
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
// Input validation
// ---------------------------------------------------------------------------

describe('smartCompare — input validation', () => {
  it('returns FAIL when actual is not an array', () => {
    const r = smartCompare('not an array', []);
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('arrays'));
    assert.equal(r.nodesProcessed, 0);
  });

  it('returns FAIL when expected is not an array', () => {
    const r = smartCompare([], 42);
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('arrays'));
    assert.equal(r.nodesProcessed, 0);
  });

  it('returns FAIL when array lengths differ', () => {
    const [actual] = linearPair();
    const [expected] = twoCycle();
    const r = smartCompare(actual, [expected[0]]); // different lengths
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('length'));
    assert.equal(r.nodesProcessed, 0);
  });

  it('returns PASS for two empty arrays', () => {
    const r = smartCompare([], []);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
    assert.equal(r.nodesProcessed, 0);
  });

  it('returns PASS for a single matching node with no dependencies', () => {
    const n1 = makeNode('x');
    const n2 = makeNode('x');
    const r = smartCompare([n1], [n2]);
    assert.equal(r.pass, true);
    assert.equal(r.nodesProcessed, 1);
  });
});

// ---------------------------------------------------------------------------
// Correct matching graphs
// ---------------------------------------------------------------------------

describe('smartCompare — matching graphs', () => {
  it('matches a simple linear pair (no cycles)', () => {
    const [actual, expected] = linearPair();
    const r = smartCompare(actual, expected);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('matches a 2-node cycle (A→B→A)', () => {
    const [actual, expected] = twoCycle();
    const r = smartCompare(actual, expected);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('matches a diamond graph with a shared-reference node', () => {
    const [actual, expected] = diamond();
    const r = smartCompare(actual, expected);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('matches a long chain-cycle (20 nodes)', () => {
    const actual = makeChainCycle(20);
    const expected = makeChainCycle(20);
    const r = smartCompare(actual, expected);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });
});

// ---------------------------------------------------------------------------
// Mismatch detection
// ---------------------------------------------------------------------------

describe('smartCompare — mismatch detection', () => {
  it('detects an id mismatch on the root node', () => {
    const a1 = makeNode('a');
    const a2 = makeNode('WRONG_ID');
    const r = smartCompare([a1], [a2]);
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('id mismatch'));
  });

  it('detects a name mismatch on a deep node', () => {
    const a1 = makeNode('a');
    const b1 = makeNode('b', 'Component b');
    a1.dependencies.push(b1);

    const a2 = makeNode('a');
    const b2 = makeNode('b', 'WRONG NAME');
    a2.dependencies.push(b2);

    const r = smartCompare([a1], [a2]);
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('name mismatch'));
  });

  it('detects a dependencies count mismatch', () => {
    const a1 = makeNode('a');
    a1.dependencies.push(makeNode('b'), makeNode('c')); // 2 deps

    const a2 = makeNode('a');
    a2.dependencies.push(makeNode('b')); // 1 dep

    const r = smartCompare([a1], [a2]);
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('dependencies length'));
  });

  it('detects a cycle in actual where expected has no cycle', () => {
    // actual:   A → B → A  (cycle)
    // expected: A → B      (no cycle back)
    const a1 = makeNode('a');
    const b1 = makeNode('b');
    a1.dependencies.push(b1);
    b1.dependencies.push(a1); // cycle

    const a2 = makeNode('a');
    const b2 = makeNode('b');
    a2.dependencies.push(b2);
    // b2 has no dep back to a2

    const r = smartCompare([a1, b1], [a2, b2]);
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null);
  });

  it('detects when expected cycles to the wrong node', () => {
    // actual:   A → B → A  (B cycles back to A)
    // expected: A → B → C  (B points to a different node C, not A)
    const a1 = makeNode('a');
    const b1 = makeNode('b');
    a1.dependencies.push(b1);
    b1.dependencies.push(a1);

    const a2 = makeNode('a');
    const b2 = makeNode('b');
    const c2 = makeNode('a'); // same id 'a' but a different object
    a2.dependencies.push(b2);
    b2.dependencies.push(c2); // c2 is NOT a2

    const r = smartCompare([a1, b1], [a2, b2]);
    assert.equal(r.pass, false);
  });

  it('detects when actual has two nodes sharing an id but expected does not', () => {
    // actual:   A → C, B → C  (C is shared — same object)
    // expected: A → C1, B → C2 (two separate objects with id 'c')
    const a1 = makeNode('a');
    const b1 = makeNode('b');
    const sharedC = makeNode('c');
    a1.dependencies.push(sharedC);
    b1.dependencies.push(sharedC); // same reference

    const a2 = makeNode('a');
    const b2 = makeNode('b');
    const c2a = makeNode('c'); // separate object
    const c2b = makeNode('c'); // another separate object — not shared
    a2.dependencies.push(c2a);
    b2.dependencies.push(c2b);

    const r = smartCompare([a1, b1, sharedC], [a2, b2, c2a]);
    // a1 pairs with a2 (c→c2a), b1 pairs with b2 (c→c2b); c2b is a different object than c2a
    // When we visit sharedC the second time (via b1), we expect it to be paired with c2a already,
    // but b2 points to c2b — a different object → mismatch
    assert.equal(r.pass, false);
  });
});

// ---------------------------------------------------------------------------
// O(V + E) correctness — nodesProcessed equals unique nodes (V)
// ---------------------------------------------------------------------------

describe('smartCompare — O(V+E): nodesProcessed reflects unique nodes', () => {
  it('counts each unique node exactly once in a linear graph', () => {
    // 3 nodes: A → B → C (no shared refs, no cycles in top-level array)
    const a1 = makeNode('a');
    const b1 = makeNode('b');
    const c1 = makeNode('c');
    a1.dependencies.push(b1);
    b1.dependencies.push(c1);

    const a2 = makeNode('a');
    const b2 = makeNode('b');
    const c2 = makeNode('c');
    a2.dependencies.push(b2);
    b2.dependencies.push(c2);

    const r = smartCompare([a1], [a2]);
    assert.equal(r.pass, true);
    // a, b, c each visited once = 3
    assert.equal(r.nodesProcessed, 3);
  });

  it('counts the shared diamond node only once', () => {
    const [actual, expected] = diamond();
    const r = smartCompare(actual, expected);
    assert.equal(r.pass, true);
    // a, b, c, d — each top-level node appears in the array; d is shared via b and c.
    // The comparator visits each unique actual object once → 4 unique nodes.
    assert.equal(r.nodesProcessed, 4);
  });

  it('counts each node of a 2-node cycle exactly once', () => {
    const [actual, expected] = twoCycle();
    const r = smartCompare(actual, expected);
    assert.equal(r.pass, true);
    // a and b are each visited once (cycle back to a is caught as already-paired)
    assert.equal(r.nodesProcessed, 2);
  });

  it('counts V unique nodes in a chain-cycle of length N', () => {
    const N = 50;
    const actual = makeChainCycle(N);
    const expected = makeChainCycle(N);
    const r = smartCompare(actual, expected);
    assert.equal(r.pass, true);
    // Each node is visited exactly once regardless of cycles
    assert.equal(r.nodesProcessed, N);
  });

  it('handles a large stress-like graph without hanging (1000 nodes)', () => {
    // Build a dense cyclic graph similar to the stress dataset:
    // each node points to a few others (with cycles), all shared via a map.
    const N = 1000;
    const actualNodes: ComponentPopulated[] = [];
    const expectedNodes: ComponentPopulated[] = [];

    for (let i = 0; i < N; i++) {
      actualNodes.push(makeNode(`node_${i}`));
      expectedNodes.push(makeNode(`node_${i}`));
    }
    // Wire edges: node_i → node_{(i+1)%N}, node_i → node_{(i+7)%N}
    for (let i = 0; i < N; i++) {
      actualNodes[i].dependencies.push(actualNodes[(i + 1) % N]);
      actualNodes[i].dependencies.push(actualNodes[(i + 7) % N]);
      expectedNodes[i].dependencies.push(expectedNodes[(i + 1) % N]);
      expectedNodes[i].dependencies.push(expectedNodes[(i + 7) % N]);
    }

    const start = performance.now();
    const r = smartCompare(actualNodes, expectedNodes);
    const elapsed = performance.now() - start;

    assert.equal(r.pass, true);
    assert.equal(r.nodesProcessed, N);
    // Should complete well under 1 second
    assert.ok(elapsed < 1000, `Expected < 1000ms but took ${elapsed.toFixed(1)}ms`);
  });
});
