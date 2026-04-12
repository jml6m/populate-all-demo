import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { AnswerEntry, ComponentFlat, ComponentPopulated } from '../algorithms/types';
import { twoPassWire } from '../algorithms/schema-driven/01-two-pass-wire';
import { buildPopulatedFromAnswer } from './answer-builder';
import { smartCompare } from './compare';
import { getDataDir, loadManifest, loadYaml } from './data-loader';

const LOGS_DIR = path.resolve(__dirname, '..', '..', 'logs');

// ---------------------------------------------------------------------------
// Helpers — build small, controlled cyclic / acyclic graphs by hand
// ---------------------------------------------------------------------------

function makeNode(id: string): ComponentPopulated {
  return { id, dependencies: [] };
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

  it('2-node cycle — back-edge fires on in-progress node, asserts nodesProcessed=2 and edgesTraversed=2', () => {
    // comp_0 → comp_1 → comp_0: when the DFS reaches comp_1 → comp_0,
    // comp_0's frame is still on the stack (it pushed comp_1 but hasn't finished),
    // yet comp_0 was added to `paired` before its frame was pushed onto the stack,
    // so the back-edge check correctly treats it as BACK-EDGE rather than re-entering it.
    const a0 = makeNode('comp_0');
    const a1 = makeNode('comp_1');
    a0.dependencies.push(a1);
    a1.dependencies.push(a0);

    const e0 = makeNode('comp_0');
    const e1 = makeNode('comp_1');
    e0.dependencies.push(e1);
    e1.dependencies.push(e0);

    const r = smartCompare([a0, a1], [e0, e1]);

    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
    assert.equal(r.nodesProcessed, 2);
    assert.equal(r.edgesTraversed, 2);
  });

  it('matches a diamond graph with a shared-reference node', () => {
    const [actual, expected] = diamond();
    const r = smartCompare(actual, expected);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
    // 4 nodes; 4 edges: a→b, a→c, b→d, c→d (the last is a back-edge to the already-visited d)
    assert.equal(r.nodesProcessed, 4);
    assert.equal(r.edgesTraversed, 4);
  });

  it('matches a long chain-cycle (20 nodes)', () => {
    const actual = makeChainCycle(20);
    const expected = makeChainCycle(20);
    const r = smartCompare(actual, expected);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
    // Each of 20 nodes is processed once; each of 20 edges (including the closing back-edge) is traversed once
    assert.equal(r.nodesProcessed, 20);
    assert.equal(r.edgesTraversed, 20);
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
    // When the DFS reaches b1's dep (a1, cycle back), the expected b2 has 0 deps →
    // "dependencies length mismatch" fires before any cycle check.
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('dependencies length'));
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
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('Cycle structure mismatch'));
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
    // When we revisit sharedC via b1→sharedC, it is already paired with c2a, but b2's dep is c2b.
    // "Cycle structure mismatch at node 'c': expected cycle target differs"
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('Cycle structure mismatch'));
  });

  it('mismatch — wrong back-edge target: actual A→B→A but expected A→B→B (self-loop)', () => {
    // actual:   A → B → A  (B cycles back to A — correct 2-node cycle)
    // expected: A → B → B  (B has a self-loop, NOT a back-edge to A)
    // The alreadyPaired guard (the alreadyPaired !== de check) catches this:
    // paired.get(actualA)=expectedA, but de=expectedB → mismatch.
    const actualA = makeNode('a');
    const actualB = makeNode('b');
    actualA.dependencies.push(actualB);
    actualB.dependencies.push(actualA); // cycle back to A

    const expectedA = makeNode('a');
    const expectedB = makeNode('b');
    expectedA.dependencies.push(expectedB);
    expectedB.dependencies.push(expectedB); // self-loop on B instead of back to A

    const r = smartCompare([actualA, actualB], [expectedA, expectedB]);

    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('Cycle structure mismatch'));
  });

  it('mismatch — swapped 2-cycle targets: reversePaired catches expected node claimed by two actuals', () => {
    // Actual has two proper 2-node cycles: [p↔q] and [r↔s]
    // Expected has the first cycle correct [p↔q], but the second cycle's back-edges
    // point to the FIRST cycle's nodes (r→q and s→p) instead of forming r↔s.
    // The reversePaired map enforces a one-to-one mapping from expected nodes to actual nodes:
    // when processing a2→a3 vs e2→e1, de=e1 is already reversePaired with a1 → mismatch.
    const a0 = makeNode('p'), a1 = makeNode('q');
    const a2 = makeNode('r'), a3 = makeNode('s');
    a0.dependencies.push(a1);
    a1.dependencies.push(a0); // cycle 1: p↔q
    a2.dependencies.push(a3);
    a3.dependencies.push(a2); // cycle 2: r↔s

    const e0 = makeNode('p'), e1 = makeNode('q');
    const e2 = makeNode('r'), e3 = makeNode('s');
    e0.dependencies.push(e1);
    e1.dependencies.push(e0); // correct cycle 1: p↔q
    e2.dependencies.push(e1); // WRONG: r→q (points to first cycle's node!)
    e3.dependencies.push(e0); // WRONG: s→p (points to first cycle's node!)

    const r = smartCompare([a0, a1, a2, a3], [e0, e1, e2, e3]);

    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('Cycle structure mismatch'));
  });
});

// ---------------------------------------------------------------------------
// O(V + E) complexity proof
//
// Strategy: build graphs at scale factors [1×, 2×, 4×, 8×] of BASE_N nodes,
// each organised as groups of GROUP_SIZE nodes forming independent short
// cycles.  This keeps the max recursion depth constant (= GROUP_SIZE) while
// letting N grow large enough for reliable timing.
//
// For each graph:
//   V = N  (every node is visited exactly once)
//   E = N × DEGREE  (every edge is traversed exactly once)
//   ops = V + E = N × (1 + DEGREE)  — mathematically deterministic
//
// Two independent checks are performed and then synthesised:
//  1. Operation count: ops(k×N) / ops(N) must equal k exactly.
//  2. Runtime scaling: time(k×N) / time(N) must be ≈ k (within tolerance).
// ---------------------------------------------------------------------------

// Fixed parameters for the complexity proof
const BASE_N = 2500; // number of nodes at the 1× scale point
const DEGREE = 2; // out-degree per node (must be < GROUP_SIZE)
const GROUP_SIZE = 10; // nodes per independent cycle — bounds max recursion depth
const SCALE_FACTORS = [1, 2, 4, 8]; // scale multipliers relative to BASE_N
const WARMUP_RUNS = 3; // JIT warm-up runs before timing
const TIMING_RUNS = 7; // timing runs; median is used
// How far the actual runtime ratio may deviate from the expected linear ratio.
// 75% tolerance means: for a 2× scale we accept ratios in [0.5, 3.5].
// This catches super-linear (O(N²)) regressions while tolerating CI noise.
const RUNTIME_TOLERANCE = 0.75;

interface ScalePoint {
  scale: number;
  N: number;
  V: number;
  E: number;
  ops: number;
  medianMs: number;
}

function makeGroupedCycleGraph(n: number): [ComponentPopulated[], ComponentPopulated[]] {
  function buildSide(): ComponentPopulated[] {
    const nodes: ComponentPopulated[] = [];
    for (let i = 0; i < n; i++) nodes.push(makeNode(`n${i}`));
    for (let g = 0; g * GROUP_SIZE < n; g++) {
      const start = g * GROUP_SIZE;
      const end = Math.min(start + GROUP_SIZE, n);
      const size = end - start;
      for (let i = 0; i < size; i++) {
        for (let k = 1; k <= DEGREE; k++) {
          nodes[start + i].dependencies.push(nodes[start + (i + k) % size]);
        }
      }
    }
    return nodes;
  }
  return [buildSide(), buildSide()];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// Compute scaling data once at describe-level so all three it() blocks share it.
const scalingData: ScalePoint[] = SCALE_FACTORS.map((scale) => {
  const N = BASE_N * scale;
  const [actual, expected] = makeGroupedCycleGraph(N);

  // Warm up the JIT and capture the last result for V/E metadata
  let lastResult = smartCompare(actual, expected);
  for (let w = 1; w < WARMUP_RUNS; w++) lastResult = smartCompare(actual, expected);

  // Collect timing samples
  const timings: number[] = [];
  for (let t = 0; t < TIMING_RUNS; t++) {
    const start = performance.now();
    lastResult = smartCompare(actual, expected);
    timings.push(performance.now() - start);
  }

  return {
    scale,
    N,
    V: lastResult.nodesProcessed,
    E: lastResult.edgesTraversed,
    ops: lastResult.nodesProcessed + lastResult.edgesTraversed,
    medianMs: median(timings),
  };
});

const baseOps = scalingData[0].ops;
const baseMs = scalingData[0].medianMs;

describe('smartCompare — O(V+E) complexity proof', () => {
  it('operation count scales exactly as O(V+E) [mathematical proof]', () => {
    const details: string[] = [];

    for (const { scale, N, V, E, ops } of scalingData) {
      // V and E must equal their expected values exactly (no tolerance)
      assert.equal(V, N, `V should equal N at scale ${scale}×`);
      assert.equal(E, N * DEGREE, `E should equal N×degree at scale ${scale}×`);

      const actualRatio = ops / baseOps;
      const expectedRatio = scale;
      details.push(`${scale}×: ops=${ops} ratio=${actualRatio.toFixed(3)} (expected=${expectedRatio})`);

      assert.equal(actualRatio, expectedRatio, `ops ratio for ${scale}× scale must be exactly ${expectedRatio}`);
    }

    console.log('   [Op Count]', details.join('  |  '));
    console.log('   ✅ Operation count scales exactly as O(V+E).');
  });

  it('runtime scales approximately as O(V+E) [empirical check]', () => {
    const details: string[] = [];

    for (const { scale, medianMs } of scalingData) {
      const actualRatio = medianMs / baseMs;
      const expectedRatio = scale;
      const lo = Math.max(0, expectedRatio * (1 - RUNTIME_TOLERANCE));
      const hi = expectedRatio * (1 + RUNTIME_TOLERANCE);
      details.push(`${scale}×: ${medianMs.toFixed(2)}ms ratio=${actualRatio.toFixed(2)} (expect [${lo.toFixed(1)}, ${hi.toFixed(1)}])`);

      assert.ok(
        actualRatio >= lo && actualRatio <= hi,
        `Runtime ratio for ${scale}× scale is ${actualRatio.toFixed(2)}, expected in [${lo.toFixed(2)}, ${hi.toFixed(2)}]`,
      );
    }

    console.log('   [Runtime ]', details.join('  |  '));
    console.log('   ✅ Runtime scales approximately as O(V+E).');
  });

  it('final verification: both checks agree on O(V+E) behavior', () => {
    let opCountPassed = true;
    let runtimePassed = true;

    for (const { scale, ops, medianMs } of scalingData) {
      if (ops / baseOps !== scale) opCountPassed = false;

      const ratio = medianMs / baseMs;
      const lo = Math.max(0, scale * (1 - RUNTIME_TOLERANCE));
      const hi = scale * (1 + RUNTIME_TOLERANCE);
      if (ratio < lo || ratio > hi) runtimePassed = false;
    }

    if (opCountPassed && runtimePassed) {
      console.log(
        '   ✅ O(V+E) VERIFIED: both operation count and runtime checks confirm linear scaling.',
      );
    } else if (opCountPassed && !runtimePassed) {
      console.error(
        '   ⚠️  O(V+E) PARTIAL: operation count mathematically confirms linear scaling; runtime check inconclusive (possible CI measurement noise).',
      );
    } else if (!opCountPassed && runtimePassed) {
      console.error(
        '   ⚠️  O(V+E) PARTIAL: runtime approximately confirms linear scaling; operation count check failed unexpectedly.',
      );
    } else {
      console.error('   ❌ O(V+E) NOT VERIFIED: both operation count and runtime checks failed.');
      assert.fail('O(V+E) not verified: both operation count and runtime checks failed.');
    }
  });
});

// ---------------------------------------------------------------------------
// Data-generation helpers for basic and acyclic-control tiers —
// used only by trace tests that need real dataset files.
// ---------------------------------------------------------------------------

/**
 * Ensures the basic-tier data files are present, generating only the basic dataset
 * if they are missing.  Using --tier basic avoids spinning up medium (5K) and
 * stress (50K) generation that would happen with a bare `npm run generate`.
 */
function ensureDataGenerated(): void {
  const dataDir = getDataDir();
  const manifestPath = path.join(dataDir, 'manifest.json');

  if (fs.existsSync(manifestPath)) {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      files?: Record<string, { filename?: string } | undefined>;
    };
    const inputFilename = raw.files?.['basic_input']?.filename;
    const answerFilename = raw.files?.['basic_answer']?.filename;
    if (
      typeof inputFilename === 'string' &&
      typeof answerFilename === 'string' &&
      fs.existsSync(path.join(dataDir, inputFilename)) &&
      fs.existsSync(path.join(dataDir, answerFilename))
    ) {
      return;
    }
  }

  console.log('[test] Basic-tier data files not found — running npm run generate --tier basic...');
  const projectRoot = path.resolve(__dirname, '..', '..');
  execSync('npm run generate -- --tier basic', { cwd: projectRoot, stdio: 'inherit' });
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Data generation did not produce manifest.json. Cannot run trace test.');
  }
}

/**
 * Ensures acyclic-control data files are present, generating only that tier
 * if they are missing.
 */
function ensureAcyclicControlDataGenerated(): void {
  const dataDir = getDataDir();
  const manifestPath = path.join(dataDir, 'manifest.json');

  if (fs.existsSync(manifestPath)) {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      files?: Record<string, { filename?: string } | undefined>;
    };
    const inputFilename = raw.files?.['acyclic-control_input']?.filename;
    const answerFilename = raw.files?.['acyclic-control_answer']?.filename;
    if (
      typeof inputFilename === 'string' &&
      typeof answerFilename === 'string' &&
      fs.existsSync(path.join(dataDir, inputFilename)) &&
      fs.existsSync(path.join(dataDir, answerFilename))
    ) {
      return;
    }
  }

  console.log('[test] Acyclic-control data files not found — running npm run generate --tier acyclic-control...');
  const projectRoot = path.resolve(__dirname, '..', '..');
  execSync('npm run generate -- --tier acyclic-control', { cwd: projectRoot, stdio: 'inherit' });
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Data generation did not produce manifest.json. Cannot run acyclic-control trace test.');
  }
}

// ---------------------------------------------------------------------------
// Trace artifact generation — cycle-structure mismatches, basic-tier, acyclic-control
//
// Writes developer-facing trace logs to logs/.  All trace-writing tests are
// grouped in this section so that artifact messages appear together at the
// end of test output rather than interspersed with correctness results.
// ---------------------------------------------------------------------------

describe('smartCompare and buildPopulatedFromAnswer — trace artifacts', () => {
  // Paths to trace files written during this run; printed once via the `after`
  // hook so a single summary appears at the very end of the trace section.
  const traceArtifacts: string[] = [];

  before(() => {
    // Ensure the logs directory exists before any trace test runs, so that
    // individual tests never need to create it themselves and appendFileSync
    // can never throw ENOENT regardless of execution order or isolation.
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  });

  after(() => {
    if (traceArtifacts.length > 0) {
      console.log('[test] Trace artifacts written:');
      for (const p of traceArtifacts) console.log(`  ${p}`);
    }
  });

  // ── Cycle-structure trace — smart-compare-trace.log ────────────────────
  //
  // All three cycle-guard scenarios (back-edge pass, wrong-back-edge, swapped
  // targets) are collected in a single self-contained test so the combined log
  // file is always written atomically and does not depend on test ordering.

  it('trace: cycle-structure scenarios (back-edge, wrong target, swapped targets) — writes smart-compare-trace.log', (t) => {
    const sections: string[] = [];

    // --- Scenario 1: 2-node cycle back-edge (pass) ---
    {
      const a0 = makeNode('comp_0'), a1 = makeNode('comp_1');
      a0.dependencies.push(a1); a1.dependencies.push(a0);
      const e0 = makeNode('comp_0'), e1 = makeNode('comp_1');
      e0.dependencies.push(e1); e1.dependencies.push(e0);

      const logLines: string[] = [];
      t.mock.method(console, 'log', (...args: unknown[]) => {
        const line = args.map(String).join(' ');
        if (line.startsWith('[smartCompare]')) logLines.push(line);
      });

      const r = smartCompare([a0, a1], [e0, e1], true);
      t.mock.restoreAll();

      assert.equal(r.pass, true);
      assert.equal(r.nodesProcessed, 2);
      assert.equal(r.edgesTraversed, 2);

      sections.push([
        '=== smartCompare verbose trace — 2-node cycle back-edge ===',
        `nodesProcessed: ${r.nodesProcessed}`,
        `edgesTraversed: ${r.edgesTraversed}`,
        `pass: ${r.pass}`,
        '',
        ...logLines,
        '',
      ].join('\n'));
    }

    // --- Scenario 2: wrong back-edge target (A→B→A vs A→B→B self-loop, fail) ---
    {
      const actualA = makeNode('a'), actualB = makeNode('b');
      actualA.dependencies.push(actualB);
      actualB.dependencies.push(actualA);
      const expectedA = makeNode('a'), expectedB = makeNode('b');
      expectedA.dependencies.push(expectedB);
      expectedB.dependencies.push(expectedB); // self-loop

      const logLines: string[] = [];
      t.mock.method(console, 'log', (...args: unknown[]) => {
        const line = args.map(String).join(' ');
        if (line.startsWith('[smartCompare]')) logLines.push(line);
      });

      const r = smartCompare([actualA, actualB], [expectedA, expectedB], true);
      t.mock.restoreAll();

      assert.equal(r.pass, false);
      assert.ok(r.errorDetail !== null && r.errorDetail.includes('Cycle structure mismatch'));

      sections.push([
        '=== smartCompare verbose trace — wrong back-edge target (A→B→A vs A→B→B) ===',
        `pass: ${r.pass}`,
        `errorDetail: ${r.errorDetail}`,
        '',
        ...logLines,
        '',
      ].join('\n'));
    }

    // --- Scenario 3: swapped 2-cycle targets (reversePaired mismatch, fail) ---
    {
      const a0 = makeNode('p'), a1 = makeNode('q'), a2 = makeNode('r'), a3 = makeNode('s');
      a0.dependencies.push(a1); a1.dependencies.push(a0);
      a2.dependencies.push(a3); a3.dependencies.push(a2);
      const e0 = makeNode('p'), e1 = makeNode('q'), e2 = makeNode('r'), e3 = makeNode('s');
      e0.dependencies.push(e1); e1.dependencies.push(e0);
      e2.dependencies.push(e1); // WRONG: r→q
      e3.dependencies.push(e0); // WRONG: s→p

      const logLines: string[] = [];
      t.mock.method(console, 'log', (...args: unknown[]) => {
        const line = args.map(String).join(' ');
        if (line.startsWith('[smartCompare]')) logLines.push(line);
      });

      const r = smartCompare([a0, a1, a2, a3], [e0, e1, e2, e3], true);
      t.mock.restoreAll();

      assert.equal(r.pass, false);
      assert.ok(r.errorDetail !== null && r.errorDetail.includes('Cycle structure mismatch'));

      sections.push([
        '=== smartCompare verbose trace — swapped 2-cycle targets (reversePaired mismatch) ===',
        `pass: ${r.pass}`,
        `errorDetail: ${r.errorDetail}`,
        '',
        ...logLines,
        '',
      ].join('\n'));
    }

    // Write all three scenarios to a single file in one atomic operation.
    const tracePath = path.join(LOGS_DIR, 'smart-compare-trace.log');
    fs.writeFileSync(tracePath, sections.join('\n'), 'utf8');
    traceArtifacts.push(tracePath);
  });

  // ── Basic-tier integration trace ───────────────────────────────────────

  it('trace: basic-tier twoPassWire — writes basic-tier-accuracy-trace.log', (t) => {
    ensureDataGenerated();

    const manifest = loadManifest();
    const inputEntry = manifest.files['basic_input'];
    const answerEntry = manifest.files['basic_answer'];
    assert.ok(inputEntry, 'basic_input missing from manifest');
    assert.ok(answerEntry, 'basic_answer missing from manifest');

    const inputData = loadYaml(inputEntry.filename) as ComponentFlat[];
    const rawAnswerEntries = loadYaml(answerEntry.filename) as AnswerEntry[];
    const expected = buildPopulatedFromAnswer(rawAnswerEntries);
    const actual = twoPassWire.execute(inputData);

    const logLines: string[] = [];
    t.mock.method(console, 'log', (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.startsWith('[smartCompare]')) logLines.push(line);
    });

    const result = smartCompare(actual, expected, true);
    t.mock.restoreAll();

    assert.equal(result.pass, true, `smartCompare failed: ${result.errorDetail ?? ''}`);
    assert.equal(result.nodesProcessed, 10, 'basic tier must have exactly 10 nodes processed');
    assert.ok(result.edgesTraversed > 0, 'edgesTraversed must be > 0');

    const tracePath = path.join(LOGS_DIR, 'basic-tier-accuracy-trace.log');
    fs.writeFileSync(tracePath, [
      '=== smartCompare verbose trace — basic tier ===',
      `nodesProcessed: ${result.nodesProcessed}`,
      `edgesTraversed: ${result.edgesTraversed}`,
      `pass: ${result.pass}`,
      '',
      ...logLines,
      '',
    ].join('\n'), 'utf8');
    traceArtifacts.push(tracePath);
  });

  it('trace: basic-tier buildPopulatedFromAnswer — writes build-answer-trace.log', () => {
    ensureDataGenerated();

    const manifest = loadManifest();
    const answerEntry = manifest.files['basic_answer'];
    assert.ok(answerEntry, 'basic_answer missing from manifest');

    const rawAnswerEntries = loadYaml(answerEntry.filename) as AnswerEntry[];

    const traceLines: string[] = ['', '=== buildPopulatedFromAnswer verbose trace — basic tier ===', ''];

    traceLines.push('--- Pass 1: Shell creation ---');
    const nodes: ComponentPopulated[] = rawAnswerEntries.map((e) => {
      traceLines.push(`Shell: ${e.id} (deps: [${e.depIndices.join(', ')}])`);
      return { id: e.id, dependencies: [] };
    });

    traceLines.push('', '--- Pass 2: Wiring ---');
    for (let i = 0; i < rawAnswerEntries.length; i++) {
      for (let d = 0; d < rawAnswerEntries[i].depIndices.length; d++) {
        const depIdx = rawAnswerEntries[i].depIndices[d];
        nodes[i].dependencies.push(nodes[depIdx]);
        traceLines.push(`Wire: ${rawAnswerEntries[i].id}.dependencies[${d}] → ${rawAnswerEntries[depIdx].id} (index ${depIdx})`);
      }
    }

    traceLines.push('', '--- Identity checks ---');
    for (let i = 0; i < rawAnswerEntries.length; i++) {
      for (let d = 0; d < rawAnswerEntries[i].depIndices.length; d++) {
        const depIdx = rawAnswerEntries[i].depIndices[d];
        const sameObject = nodes[i].dependencies[d] === nodes[depIdx];
        traceLines.push(`Identity check: nodes[${i}].dependencies[${d}] === nodes[${depIdx}] → ${sameObject}`);
        assert.equal(sameObject, true, `Identity check failed: nodes[${i}].dependencies[${d}] should be nodes[${depIdx}]`);
      }
    }

    const tracePath = path.join(LOGS_DIR, 'build-answer-trace.log');
    fs.writeFileSync(tracePath, traceLines.join('\n') + '\n', 'utf8');
    traceArtifacts.push(tracePath);
  });

  // ── Acyclic-control tier trace ─────────────────────────────────────────

  it('trace: acyclic-control twoPassWire — writes acyclic-control-accuracy-trace.log', (t) => {
    ensureAcyclicControlDataGenerated();

    const manifest = loadManifest();
    const inputEntry = manifest.files['acyclic-control_input'];
    const answerEntry = manifest.files['acyclic-control_answer'];
    assert.ok(inputEntry, 'acyclic-control_input missing from manifest');
    assert.ok(answerEntry, 'acyclic-control_answer missing from manifest');

    const inputData = loadYaml(inputEntry.filename) as ComponentFlat[];
    const rawAnswerEntries = loadYaml(answerEntry.filename) as AnswerEntry[];
    const expected = buildPopulatedFromAnswer(rawAnswerEntries);
    const actualTwp = twoPassWire.execute(inputData);

    const logLines: string[] = [];
    t.mock.method(console, 'log', (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.startsWith('[smartCompare]')) logLines.push(line);
    });

    const twpResult = smartCompare(actualTwp, expected, true);
    t.mock.restoreAll();

    assert.equal(twpResult.pass, true, `twoPassWire smartCompare failed: ${twpResult.errorDetail ?? ''}`);
    assert.equal(twpResult.nodesProcessed, 10, 'acyclic-control tier must have exactly 10 nodes processed');

    const tracePath = path.join(LOGS_DIR, 'acyclic-control-accuracy-trace.log');
    fs.writeFileSync(tracePath, [
      '=== smartCompare verbose trace — acyclic-control tier ===',
      `nodesProcessed: ${twpResult.nodesProcessed}`,
      `edgesTraversed: ${twpResult.edgesTraversed}`,
      `twoPassWire pass: ${twpResult.pass}`,
      '',
      'Dataset structure: 10-node DAG (higher-index nodes depend on lower-index nodes only).',
      'No cycles exist.  Algorithms with memoization (Map Tracker, Two-Pass Wire, Tarjan SCC)',
      'pass cleanly.  Naive Recursion fails: it creates a fresh object per populate() call,',
      'producing a shared-reference mismatch even without cycles.',
      '',
      ...logLines,
      '',
    ].join('\n'), 'utf8');
    traceArtifacts.push(tracePath);
  });

  it('trace: acyclic-control buildPopulatedFromAnswer — writes acyclic-control-build-answer-trace.log', () => {
    ensureAcyclicControlDataGenerated();

    const manifest = loadManifest();
    const answerEntry = manifest.files['acyclic-control_answer'];
    assert.ok(answerEntry, 'acyclic-control_answer missing from manifest');

    const rawAnswerEntries = loadYaml(answerEntry.filename) as AnswerEntry[];

    const traceLines: string[] = [
      '',
      '=== buildPopulatedFromAnswer verbose trace — acyclic-control tier ===',
      '',
      'Dataset structure: 10-node DAG (higher-index nodes depend on lower-index nodes only).',
      'No cycles exist.  Dependency edges are present; identity-sharing is required for',
      'any node that appears as a dependency of multiple parents.',
      'Algorithms with memoization reconstruct this correctly; Naive Recursion does not.',
      '',
    ];

    traceLines.push('--- Pass 1: Shell creation ---');
    const nodes: ComponentPopulated[] = rawAnswerEntries.map((e) => {
      traceLines.push(`Shell: ${e.id} (deps: [${e.depIndices.join(', ')}])`);
      return { id: e.id, dependencies: [] };
    });

    traceLines.push('', '--- Pass 2: Wiring ---');
    let totalEdges = 0;
    for (let i = 0; i < rawAnswerEntries.length; i++) {
      for (let d = 0; d < rawAnswerEntries[i].depIndices.length; d++) {
        const depIdx = rawAnswerEntries[i].depIndices[d];
        nodes[i].dependencies.push(nodes[depIdx]);
        traceLines.push(`Wire: ${rawAnswerEntries[i].id}.dependencies[${d}] → ${rawAnswerEntries[depIdx].id} (index ${depIdx})`);
        totalEdges++;
      }
    }
    traceLines.push(`Total edges wired: ${totalEdges}`);

    traceLines.push('', '--- Identity checks ---');
    for (let i = 0; i < rawAnswerEntries.length; i++) {
      for (let d = 0; d < rawAnswerEntries[i].depIndices.length; d++) {
        const depIdx = rawAnswerEntries[i].depIndices[d];
        const sameObject = nodes[i].dependencies[d] === nodes[depIdx];
        traceLines.push(`Identity check: nodes[${i}].dependencies[${d}] === nodes[${depIdx}] → ${sameObject}`);
        assert.equal(sameObject, true, `Identity check failed: nodes[${i}].dependencies[${d}] should be nodes[${depIdx}]`);
      }
    }
    if (totalEdges === 0) {
      traceLines.push('(no identity checks required — zero dependency edges)');
    }

    const tracePath = path.join(LOGS_DIR, 'acyclic-control-build-answer-trace.log');
    fs.writeFileSync(tracePath, traceLines.join('\n') + '\n', 'utf8');
    traceArtifacts.push(tracePath);
  });
});
