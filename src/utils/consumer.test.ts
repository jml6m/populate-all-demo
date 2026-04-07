import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { AnswerEntry, ComponentFlat, ComponentPopulated } from '../algorithms/types';
import { twoPassWire } from '../algorithms/schema-driven/01-two-pass-wire';
import { ConsumerResult, cycleFlatProbe, naiveJsonProbe } from './consumer';
import { getDataDir, loadManifest, loadYaml } from './data-loader';

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
    assert.deepEqual(r.serializedOutput, []);
  });

  it('passes on a single node with no dependencies', () => {
    const r = cycleFlatProbe.consume([makeNode('solo')]);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
    assert.deepEqual(r.serializedOutput, [{ id: 'solo', depIndices: [] }]);
  });

  it('passes on an acyclic linear pair and produces correct AnswerEntry output', () => {
    const r = cycleFlatProbe.consume(linearPair());
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
    // a (index 0) depends on b (index 1)
    assert.deepEqual(r.serializedOutput, [
      { id: 'a', depIndices: [1] },
      { id: 'b', depIndices: [] },
    ]);
  });

  it('passes on a diamond graph and produces correct AnswerEntry output', () => {
    const r = cycleFlatProbe.consume(diamond());
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
    // a(0)→b(1),c(2)  b(1)→d(3)  c(2)→d(3)  d(3)→[]
    assert.deepEqual(r.serializedOutput, [
      { id: 'a', depIndices: [1, 2] },
      { id: 'b', depIndices: [3] },
      { id: 'c', depIndices: [3] },
      { id: 'd', depIndices: [] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// cycleFlatProbe — cyclic graphs
// ---------------------------------------------------------------------------

describe('cycleFlatProbe — cyclic graphs', () => {
  it('passes on a 2-node cycle and produces correct AnswerEntry output', () => {
    const r = cycleFlatProbe.consume(twoCycle());
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
    // a(0)→b(1)  b(1)→a(0)
    assert.deepEqual(r.serializedOutput, [
      { id: 'a', depIndices: [1] },
      { id: 'b', depIndices: [0] },
    ]);
  });

  it('passes on a long chain-cycle (20 nodes)', () => {
    const r = cycleFlatProbe.consume(makeChainCycle(20));
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
    assert.ok(Array.isArray(r.serializedOutput));
    assert.equal(r.serializedOutput!.length, 20);
    // Each node i should have depIndices [(i+1) % 20]
    for (let i = 0; i < 20; i++) {
      assert.deepEqual(r.serializedOutput![i].depIndices, [(i + 1) % 20]);
    }
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
    assert.equal(r.serializedOutput, null);
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
    assert.equal(naiveResult.serializedOutput, null);

    // cycle-flat handles the same graph without issue and produces output
    assert.equal(flatResult.pass, true, 'cycleFlatProbe should pass on cyclic graph');
    assert.equal(flatResult.errorDetail, null);
    assert.ok(flatResult.serializedOutput !== null, 'cycleFlatProbe should produce serializedOutput');

    // Write trace log for auditing
    fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
    const tracePath = path.join(ANALYSIS_DIR, 'consumer-probe-trace.log');
    const logLines = [
      '=== Consumer probe contrast — 2-node cycle (a → b → a) ===',
      '',
      `naive-json  : pass=${naiveResult.pass}, error="${String(naiveResult.errorDetail)}"`,
      `cycle-flat  : pass=${flatResult.pass}, error="${String(flatResult.errorDetail)}"`,
      `cycle-flat serializedOutput: ${JSON.stringify(flatResult.serializedOutput)}`,
      '',
      'Interpretation:',
      '  A graph that was correctly hydrated (all object references intact) still',
      '  crashes a naive JSON.stringify consumer. The cycle-flat probe succeeds on',
      '  the same graph by using an iterative index-based export — no recursion,',
      '  no circular reference errors.',
      '  The cycle-flat output is an AnswerEntry[] that preserves full graph fidelity.',
    ];
    fs.writeFileSync(tracePath, logLines.join('\n') + '\n', 'utf8');
  });

  it('naiveJsonProbe passes and cycleFlatProbe passes on an acyclic graph — both succeed', () => {
    const graph = linearPair();

    const naiveResult = naiveJsonProbe.consume(graph);
    const flatResult = cycleFlatProbe.consume(graph);

    assert.equal(naiveResult.pass, true, 'naiveJsonProbe should pass on acyclic graph');
    assert.equal(flatResult.pass, true, 'cycleFlatProbe should pass on acyclic graph');
    assert.ok(flatResult.serializedOutput !== null);
  });
});

// ---------------------------------------------------------------------------
// cycleFlatProbe — basic-tier integration (manifest data)
// Mirrors the flatCompare integration test: loads real data, runs twoPassWire,
// runs the probe, and verifies the probe's AnswerEntry[] output against the
// known-correct answer file from the manifest.
// ---------------------------------------------------------------------------

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
    throw new Error('Data generation did not produce manifest.json. Cannot run cycleFlatProbe integration test.');
  }
}

describe('cycleFlatProbe — basic-tier integration', () => {
  it('builds a correct AnswerEntry[] from twoPassWire output — verified against manifest answer', () => {
    ensureDataGenerated();

    const manifest = loadManifest();
    const inputEntry = manifest.files['basic_input'];
    const answerEntry = manifest.files['basic_answer'];
    assert.ok(inputEntry, 'basic_input missing from manifest');
    assert.ok(answerEntry, 'basic_answer missing from manifest');

    const inputData = loadYaml(inputEntry.filename) as ComponentFlat[];
    const rawAnswerEntries = loadYaml(answerEntry.filename) as AnswerEntry[];

    // Run the algorithm that is known to produce a correct graph
    const graph = twoPassWire.execute(inputData);

    // (1) Did the probe generate a valid output?
    const r = cycleFlatProbe.consume(graph);
    assert.equal(r.pass, true, `cycleFlatProbe failed: ${r.errorDetail ?? ''}`);
    assert.ok(r.serializedOutput !== null, 'cycleFlatProbe should produce serializedOutput');

    // (2) Is the output correct? Compare against the manifest answer entries.
    const output = r.serializedOutput!;
    assert.equal(output.length, rawAnswerEntries.length, 'Output entry count should match answer entry count');
    for (let i = 0; i < rawAnswerEntries.length; i++) {
      assert.equal(output[i].id, rawAnswerEntries[i].id, `Entry[${i}] id mismatch`);
      assert.deepEqual(
        output[i].depIndices,
        rawAnswerEntries[i].depIndices,
        `Entry[${i}] ("${output[i].id}") depIndices mismatch`,
      );
    }

    // Write trace log for auditing
    fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
    const tracePath = path.join(ANALYSIS_DIR, 'cycle-flat-probe-trace.log');
    const header = [
      '=== cycleFlatProbe integration trace — basic-tier twoPassWire ===',
      `nodes: ${output.length}`,
      `edges: ${output.reduce((sum, e) => sum + e.depIndices.length, 0)}`,
      `output matches manifest answer: true`,
      '',
      'Sample output (first 5 entries):',
    ];
    const sample = output.slice(0, 5).map(
      (e) => `  { id: "${e.id}", depIndices: [${e.depIndices.join(', ')}] }`,
    );
    fs.writeFileSync(tracePath, [...header, ...sample].join('\n') + '\n', 'utf8');
  });
});
