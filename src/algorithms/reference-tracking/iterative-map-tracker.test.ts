import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { AnswerEntry, ComponentFlat } from '../types';
import { iterativeMapTracker } from './03-iterative-map-tracker';
import { twoPassWire } from '../schema-driven/01-two-pass-wire';
import { buildPopulatedFromAnswer } from '../../utils/answer-builder';
import { smartCompare } from '../../utils/compare';
import { flatCompare } from '../../utils/flat-compare';
import { serializeCheck } from '../../utils/serialize-check';
import { getDataDir, loadManifest, loadYaml } from '../../utils/data-loader';

const ANALYSIS_DIR = path.resolve(__dirname, '..', '..', '..', 'analysis');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFlat(id: string, dependencies: string[]): ComponentFlat {
  return { id, dependencies };
}

// ---------------------------------------------------------------------------
// Correctness tests — hand-constructed graphs
// ---------------------------------------------------------------------------

describe('iterativeMapTracker — correctness', () => {
  it('handles an empty input', () => {
    const result = iterativeMapTracker.execute([]);
    assert.deepEqual(result, []);
  });

  it('handles a single node with no dependencies', () => {
    const input = [makeFlat('a', [])];
    const result = iterativeMapTracker.execute(input);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'a');
    assert.deepEqual(result[0].dependencies, []);
  });

  it('handles a simple linear pair (a → b)', () => {
    const input = [makeFlat('a', ['b']), makeFlat('b', [])];
    const result = iterativeMapTracker.execute(input);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'a');
    assert.equal(result[1].id, 'b');
    assert.equal(result[0].dependencies.length, 1);
    assert.equal(result[0].dependencies[0].id, 'b');
    assert.equal(result[0].dependencies[0], result[1]); // same object reference
  });

  it('handles a 2-node cycle (a → b → a)', () => {
    const input = [makeFlat('a', ['b']), makeFlat('b', ['a'])];
    const result = iterativeMapTracker.execute(input);
    assert.equal(result.length, 2);
    const [a, b] = result;
    assert.equal(a.id, 'a');
    assert.equal(b.id, 'b');
    assert.equal(a.dependencies[0], b); // a → b (same object)
    assert.equal(b.dependencies[0], a); // b → a (same object — cycle)
  });

  it('handles a 3-node cycle (a → b → c → a)', () => {
    const input = [makeFlat('a', ['b']), makeFlat('b', ['c']), makeFlat('c', ['a'])];
    const result = iterativeMapTracker.execute(input);
    assert.equal(result.length, 3);
    const [a, b, c] = result;
    assert.equal(a.dependencies[0], b);
    assert.equal(b.dependencies[0], c);
    assert.equal(c.dependencies[0], a); // cycle back to a
  });

  it('handles a self-loop (a → a)', () => {
    const input = [makeFlat('a', ['a'])];
    const result = iterativeMapTracker.execute(input);
    assert.equal(result.length, 1);
    const [a] = result;
    assert.equal(a.dependencies[0], a); // self-loop
  });

  it('handles a diamond graph (a→b, a→c, b→d, c→d)', () => {
    const input = [makeFlat('a', ['b', 'c']), makeFlat('b', ['d']), makeFlat('c', ['d']), makeFlat('d', [])];
    const result = iterativeMapTracker.execute(input);
    const [a, b, c, d] = result;
    assert.equal(a.dependencies[0], b);
    assert.equal(a.dependencies[1], c);
    assert.equal(b.dependencies[0], d);
    assert.equal(c.dependencies[0], d);
    assert.equal(b.dependencies[0], c.dependencies[0]); // d is the SAME object reference
  });

  it('handles multiple independent components', () => {
    const input = [makeFlat('x', []), makeFlat('y', [])];
    const result = iterativeMapTracker.execute(input);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'x');
    assert.equal(result[1].id, 'y');
  });

  it('throws when a dependency id is not in the input', () => {
    const input = [makeFlat('a', ['missing'])];
    assert.throws(() => iterativeMapTracker.execute(input), /missing/);
  });
});

// ---------------------------------------------------------------------------
// Agreement with twoPassWire (both must produce identical graph topology)
// ---------------------------------------------------------------------------

describe('iterativeMapTracker — agrees with twoPassWire on various topologies', () => {
  function assertAgreement(label: string, input: ComponentFlat[]): void {
    const expected = twoPassWire.execute(input);
    const actual = iterativeMapTracker.execute(input);
    const r = smartCompare(actual, expected);
    assert.equal(r.pass, true, `[${label}] smartCompare mismatch: ${r.errorDetail ?? ''}`);

    const rawAnswer: AnswerEntry[] = expected.map((node, _i) => ({
      id: node.id,
      depIndices: node.dependencies.map((dep) => expected.indexOf(dep)),
    }));
    const rf = flatCompare(actual, rawAnswer);
    assert.equal(rf.pass, true, `[${label}] flatCompare mismatch: ${rf.errorDetail ?? ''}`);
  }

  it('empty graph', () => assertAgreement('empty', []));

  it('single acyclic node', () => assertAgreement('single', [makeFlat('a', [])]));

  it('linear chain a→b→c', () => {
    assertAgreement('linear', [makeFlat('a', ['b']), makeFlat('b', ['c']), makeFlat('c', [])]);
  });

  it('2-node cycle a↔b', () => {
    assertAgreement('2-cycle', [makeFlat('a', ['b']), makeFlat('b', ['a'])]);
  });

  it('3-node cycle a→b→c→a', () => {
    assertAgreement('3-cycle', [makeFlat('a', ['b']), makeFlat('b', ['c']), makeFlat('c', ['a'])]);
  });

  it('diamond with shared node', () => {
    assertAgreement('diamond', [makeFlat('a', ['b', 'c']), makeFlat('b', ['d']), makeFlat('c', ['d']), makeFlat('d', [])]);
  });

  it('mutual back-references: a→b, b→a, b→c, c→b', () => {
    assertAgreement('mutual', [makeFlat('a', ['b']), makeFlat('b', ['a', 'c']), makeFlat('c', ['b'])]);
  });
});

// ---------------------------------------------------------------------------
// Serialization: hydration passes, JSON.stringify fails (cyclic refs)
// This is the key finding from issue #16: hydration correctness ≠ serialization safety.
// ---------------------------------------------------------------------------

describe('iterativeMapTracker — serialization check (issue #16)', () => {
  it('acyclic output is serializable', () => {
    const input = [makeFlat('a', ['b']), makeFlat('b', [])];
    const result = iterativeMapTracker.execute(input);
    const r = serializeCheck(result);
    assert.equal(r.pass, true, `Expected serializable for acyclic graph, got: ${r.errorDetail ?? ''}`);
  });

  it('cyclic output is NOT serializable — hydration passes but JSON.stringify throws', () => {
    const input = [makeFlat('a', ['b']), makeFlat('b', ['a'])];
    const result = iterativeMapTracker.execute(input);

    // Hydration must pass
    const expected = twoPassWire.execute(input);
    const hydrationResult = smartCompare(result, expected);
    assert.equal(hydrationResult.pass, true, `Hydration should PASS for iterative map tracker`);

    // Serialization must fail (cyclic object graph)
    const serResult = serializeCheck(result);
    assert.equal(serResult.pass, false, 'Expected serializeCheck to FAIL for cyclic output (this is expected behavior)');
    assert.ok(serResult.errorDetail !== null, 'errorDetail should be set when serialization fails');
  });
});

// ---------------------------------------------------------------------------
// Integration test — basic-tier data files
// Follows the project convention: use real generated data and write a trace
// log to analysis/ so CI uploads it as an artifact for auditing.
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
  const projectRoot = path.resolve(__dirname, '..', '..', '..');
  execSync('npm run generate -- --tier basic', { cwd: projectRoot, stdio: 'inherit' });
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Data generation did not produce manifest.json. Cannot run iterativeMapTracker integration test.');
  }
}

describe('iterativeMapTracker — verbose basic-tier trace', () => {
  it('runs on basic data, double-verifies with smartCompare + flatCompare, writes trace log', (t) => {
    ensureDataGenerated();

    const manifest = loadManifest();
    const inputEntry = manifest.files['basic_input'];
    const answerEntry = manifest.files['basic_answer'];
    assert.ok(inputEntry, 'basic_input missing from manifest');
    assert.ok(answerEntry, 'basic_answer missing from manifest');

    const inputData = loadYaml(inputEntry.filename) as ComponentFlat[];
    const rawAnswerEntries = loadYaml(answerEntry.filename) as AnswerEntry[];
    const expected = buildPopulatedFromAnswer(rawAnswerEntries);
    const actual = iterativeMapTracker.execute(inputData);

    const logLines: string[] = [];
    t.mock.method(console, 'log', (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.startsWith('[smartCompare]')) {
        logLines.push(line);
      }
    });

    const smartResult = smartCompare(actual, expected, true);

    t.mock.restoreAll();

    assert.equal(smartResult.pass, true, `smartCompare failed: ${smartResult.errorDetail ?? ''}`);
    assert.equal(smartResult.nodesProcessed, 10, 'basic tier must have exactly 10 nodes processed');
    assert.ok(smartResult.edgesTraversed > 0, 'edgesTraversed must be > 0');

    const flatResult = flatCompare(actual, rawAnswerEntries);
    assert.equal(flatResult.pass, true, `flatCompare failed: ${flatResult.errorDetail ?? ''}`);

    // Serialization check — basic tier has cycles, so this is expected to FAIL
    const serResult = serializeCheck(actual);

    // Write trace to analysis directory
    fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
    const tracePath = path.join(ANALYSIS_DIR, 'iterative-map-tracker-trace.log');
    const header = [
      '=== iterativeMapTracker verbose trace — basic tier ===',
      `nodesProcessed: ${smartResult.nodesProcessed}`,
      `edgesTraversed: ${smartResult.edgesTraversed}`,
      `hydration pass: ${smartResult.pass}`,
      `flatCompare pass: ${flatResult.pass}`,
      `serializationCheck pass: ${serResult.pass}  ← expected false for cyclic graph`,
      `serializationCheck error: ${serResult.errorDetail ?? 'none'}`,
      '',
    ];
    fs.writeFileSync(tracePath, [...header, ...logLines].join('\n') + '\n', 'utf8');
    console.log(`[test] iterativeMapTracker trace written to ${tracePath}`);
  });
});
