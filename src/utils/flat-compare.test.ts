import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { twoPassWire } from '../algorithms/schema-driven/01-two-pass-wire';
import { AnswerEntry, ComponentFlat, ComponentPopulated } from '../algorithms/types';
import { getDataDir, loadManifest, loadYaml } from './data-loader';
import { flatCompare } from './flat-compare';

// ---------------------------------------------------------------------------
// Why flatCompare exists alongside smartCompare
//
// The experiment uses two independent accuracy checks that together eliminate
// entire categories of false-positive results:
//
//   smartCompare  — validates object-identity (shared references, cycle structure).
//                   Requires a reference graph built by buildPopulatedFromAnswer.
//                   If both the algorithm and buildPopulatedFromAnswer share the same
//                   structural bug, smartCompare may still pass (both sides carry the
//                   same defect, so they appear to match each other).
//
//   flatCompare   — validates the index-level flat representation directly against
//                   the raw AnswerEntry[] from the answer YAML file.
//                   Catches bugs invisible to smartCompare when the same structural
//                   error appears in both the algorithm output and the reference graph.
//
// Together they form a cross-verification layer: correctness requires BOTH checks
// to pass, and a comparer conflict (one passes, the other fails) is surfaced
// prominently in experiment output.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers — build small, controlled graphs paired with their AnswerEntry[]
// ---------------------------------------------------------------------------

function makeNode(id: string): ComponentPopulated {
  return { id, dependencies: [] };
}

/** Linear: a → b */
function buildLinear(): [ComponentPopulated[], AnswerEntry[]] {
  const a = makeNode('a');
  const b = makeNode('b');
  a.dependencies.push(b);
  return [
    [a, b],
    [
      { id: 'a', depIndices: [1] },
      { id: 'b', depIndices: [] },
    ],
  ];
}

/** 2-node cycle: a → b → a */
function buildTwoCycle(): [ComponentPopulated[], AnswerEntry[]] {
  const a = makeNode('a');
  const b = makeNode('b');
  a.dependencies.push(b);
  b.dependencies.push(a);
  return [
    [a, b],
    [
      { id: 'a', depIndices: [1] },
      { id: 'b', depIndices: [0] },
    ],
  ];
}

/** Diamond: a→b, a→c, b→d, c→d (d shared) */
function buildDiamond(): [ComponentPopulated[], AnswerEntry[]] {
  const a = makeNode('a');
  const b = makeNode('b');
  const c = makeNode('c');
  const d = makeNode('d');
  a.dependencies.push(b, c);
  b.dependencies.push(d);
  c.dependencies.push(d); // same object — shared reference
  return [
    [a, b, c, d],
    [
      { id: 'a', depIndices: [1, 2] },
      { id: 'b', depIndices: [3] },
      { id: 'c', depIndices: [3] },
      { id: 'd', depIndices: [] },
    ],
  ];
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

void describe('flatCompare — input validation', () => {
  void it('returns FAIL when actual is not an array', () => {
    const r = flatCompare('not an array' as unknown as ComponentPopulated[], []);
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('arrays'));
  });

  void it('returns FAIL when rawAnswerEntries is not an array', () => {
    const r = flatCompare([], 42 as unknown as AnswerEntry[]);
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('arrays'));
  });

  void it('returns FAIL when array lengths differ', () => {
    const [actual] = buildLinear();
    const r = flatCompare(actual, [{ id: 'a', depIndices: [] }]);
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('Length mismatch'));
  });

  void it('returns PASS for two empty arrays', () => {
    const r = flatCompare([], []);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  void it('returns PASS for a single matching node with no dependencies', () => {
    const node = makeNode('x');
    const r = flatCompare([node], [{ id: 'x', depIndices: [] }]);
    assert.equal(r.pass, true);
  });
});

// ---------------------------------------------------------------------------
// Correct matching graphs
// ---------------------------------------------------------------------------

void describe('flatCompare — matching graphs', () => {
  void it('matches a simple linear pair (no cycles)', () => {
    const [actual, entries] = buildLinear();
    const r = flatCompare(actual, entries);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  void it('matches a 2-node cycle', () => {
    const [actual, entries] = buildTwoCycle();
    const r = flatCompare(actual, entries);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  void it('matches a diamond graph with a shared-reference node', () => {
    const [actual, entries] = buildDiamond();
    const r = flatCompare(actual, entries);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });
});

// ---------------------------------------------------------------------------
// Mismatch detection
// ---------------------------------------------------------------------------

void describe('flatCompare — mismatch detection', () => {
  void it('detects a wrong id', () => {
    const node = makeNode('a');
    const r = flatCompare([node], [{ id: 'WRONG', depIndices: [] }]);
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('id mismatch'));
  });

  void it('detects wrong dependencies (different dep count)', () => {
    const a = makeNode('a');
    const b = makeNode('b');
    a.dependencies.push(b);
    // actual has dep on b (index 1), but entry says no deps
    const r = flatCompare(
      [a, b],
      [
        { id: 'a', depIndices: [] },
        { id: 'b', depIndices: [] },
      ]
    );
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('dep count mismatch'));
  });

  void it('detects wrong dep target index', () => {
    const a = makeNode('a');
    const b = makeNode('b');
    const c = makeNode('c');
    a.dependencies.push(b); // actual: a → b (index 1)
    // entry says a → c (index 2)
    const r = flatCompare(
      [a, b, c],
      [
        { id: 'a', depIndices: [2] },
        { id: 'b', depIndices: [] },
        { id: 'c', depIndices: [] },
      ]
    );
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('dep mismatch'));
  });

  void it('detects a cycle structure difference', () => {
    // actual: a → b (no cycle back)
    const a = makeNode('a');
    const b = makeNode('b');
    a.dependencies.push(b);
    // entries claim b → a (cycle), actual does not have this
    const r = flatCompare(
      [a, b],
      [
        { id: 'a', depIndices: [1] },
        { id: 'b', depIndices: [0] },
      ]
    );
    assert.equal(r.pass, false);
  });

  void it('returns FAIL when a dependency is not in the top-level array', () => {
    // Build a node whose dependency is an "orphan" not in the top-level array
    const a = makeNode('a');
    const orphan = makeNode('orphan');
    a.dependencies.push(orphan); // orphan is NOT in actual[]
    const r = flatCompare([a], [{ id: 'a', depIndices: [0] }]);
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('not present in the top-level'));
  });
});

// ---------------------------------------------------------------------------
// Integration test — real basic-tier data files
// ---------------------------------------------------------------------------

/**
 * Ensures the basic-tier data files are present, generating only the basic dataset
 * if they are missing.  Using --tier basic avoids spinning up the medium (5 K) and
 * stress (50 K) generation that would happen with a bare `npm run generate`.
 */
function ensureDataGenerated(): void {
  const dataDir = getDataDir();
  const manifestPath = path.join(dataDir, 'manifest.json');

  if (fs.existsSync(manifestPath)) {
    // Check that the basic entries specifically are present and their files exist.
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
      return; // Basic-tier files already present
    }
  }

  // Generate only the basic dataset to avoid creating medium (5 K) and stress (50 K) files.
  console.log('[test] Basic-tier data files not found — running npm run generate --tier basic...');
  const projectRoot = path.resolve(__dirname, '..', '..');
  execSync('npm run generate -- --tier basic', { cwd: projectRoot, stdio: 'inherit' });
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Data generation did not produce manifest.json. Cannot run flatCompare integration test.');
  }
}

void describe('flatCompare — basic-tier integration', () => {
  void it('twoPassWire output passes flatCompare against raw basic_answer entries', () => {
    ensureDataGenerated();

    const manifest = loadManifest();
    const inputEntry = manifest.files['basic_input'];
    const answerEntry = manifest.files['basic_answer'];
    assert.ok(inputEntry, 'basic_input missing from manifest');
    assert.ok(answerEntry, 'basic_answer missing from manifest');

    const inputData = loadYaml(inputEntry.filename) as ComponentFlat[];
    const rawAnswerEntries = loadYaml(answerEntry.filename) as AnswerEntry[];

    const actual = twoPassWire.execute(inputData);
    const r = flatCompare(actual, rawAnswerEntries);

    assert.equal(r.pass, true, `flatCompare failed: ${r.errorDetail ?? ''}`);
  });
});

// ---------------------------------------------------------------------------
// Cross-check differentiation — bugs flatCompare catches that reference-only
// comparisons may miss
// ---------------------------------------------------------------------------

void describe('flatCompare — differentiation from smartCompare', () => {
  void it('catches a missing dependency that a reference-only comparison would miss', () => {
    // Scenario: the algorithm forgets to wire a → b, but the raw answer file says
    // a should depend on b. A reference graph built from the same buggy output would
    // also lack the a→b edge, so smartCompare (which compares two hydrated graphs)
    // would see a "match" — both sides have no dep. flatCompare compares the actual
    // against the raw AnswerEntry[] from the YAML answer file and catches the bug.
    const actualA = makeNode('a');
    const actualB = makeNode('b');
    // BUG: actualA.dependencies is empty — the a→b edge is missing
    const actual = [actualA, actualB];

    const rawEntries: AnswerEntry[] = [
      { id: 'a', depIndices: [1] }, // truth: a should depend on b
      { id: 'b', depIndices: [] },
    ];

    const r = flatCompare(actual, rawEntries);
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null && r.errorDetail.includes('dep count mismatch'));
  });
});
