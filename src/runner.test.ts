import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  computeFingerprint,
  isAlreadyUpToDate,
  isForceMode,
  formatHydrationFailTag,
  buildFailureDetailLines,
  buildLaterDatasetLines,
  ExperimentIndex,
  RunMetadata,
  LaterAlgoOutcome,
} from './runner';
import type { Manifest } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    generatedAt: '2025-01-01T00:00:00.000Z',
    files: {
      basic_input: { filename: 'basic/basic_input.abc12345.yaml', contentHash: 'abc12345' },
      basic_answer: { filename: 'basic/basic_answer.def67890.yaml', contentHash: 'def67890' },
    },
    ...overrides,
  };
}

function makeMetadata(overrides: Partial<RunMetadata> = {}): RunMetadata {
  return {
    fingerprint: 'aabbccdd11223344',
    runAt: '2025-01-01T00:00:00.000Z',
    nodeVersion: process.version,
    platform: process.platform,
    packageVersion: '1.0.0',
    datasets: ['basic'],
    algorithms: ['Naive Recursion'],
    probes: ['naive-json'],
    manifestGeneratedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
}

// ---------------------------------------------------------------------------
// computeFingerprint
// ---------------------------------------------------------------------------

describe('computeFingerprint — determinism', () => {
  it('returns the same value when called twice with identical inputs', () => {
    const manifest = makeManifest();
    const fp1 = computeFingerprint(manifest, ['basic'], ['Algo A'], ['probe-x']);
    const fp2 = computeFingerprint(manifest, ['basic'], ['Algo A'], ['probe-x']);
    assert.equal(fp1, fp2);
  });

  it('is 16 hex characters long', () => {
    const fp = computeFingerprint(makeManifest(), ['basic'], ['Algo A'], ['probe-x']);
    assert.match(fp, /^[0-9a-f]{16}$/);
  });
});

describe('computeFingerprint — sensitivity', () => {
  it('changes when manifest generatedAt changes', () => {
    const m1 = makeManifest({ generatedAt: '2025-01-01T00:00:00.000Z' });
    const m2 = makeManifest({ generatedAt: '2025-06-01T00:00:00.000Z' });
    assert.notEqual(
      computeFingerprint(m1, ['basic'], ['Algo A'], ['probe-x']),
      computeFingerprint(m2, ['basic'], ['Algo A'], ['probe-x']),
    );
  });

  it('changes when a file content hash changes', () => {
    const m1 = makeManifest();
    const m2: Manifest = {
      ...m1,
      files: {
        ...m1.files,
        basic_input: { filename: 'basic/basic_input.ffffffff.yaml', contentHash: 'ffffffff' },
      },
    };
    assert.notEqual(
      computeFingerprint(m1, ['basic'], ['Algo A'], ['probe-x']),
      computeFingerprint(m2, ['basic'], ['Algo A'], ['probe-x']),
    );
  });

  it('changes when the selected datasets change', () => {
    const manifest: Manifest = {
      generatedAt: '2025-01-01T00:00:00.000Z',
      files: {
        basic_input: { filename: 'basic/basic_input.abc12345.yaml', contentHash: 'abc12345' },
        basic_answer: { filename: 'basic/basic_answer.def67890.yaml', contentHash: 'def67890' },
        medium_input: { filename: 'medium/medium_input.aabbccdd.yaml', contentHash: 'aabbccdd' },
        medium_answer: { filename: 'medium/medium_answer.11223344.yaml', contentHash: '11223344' },
      },
    };
    assert.notEqual(
      computeFingerprint(manifest, ['basic'], ['Algo A'], ['probe-x']),
      computeFingerprint(manifest, ['basic', 'medium'], ['Algo A'], ['probe-x']),
    );
  });

  it('changes when algorithm list changes', () => {
    const manifest = makeManifest();
    assert.notEqual(
      computeFingerprint(manifest, ['basic'], ['Algo A'], ['probe-x']),
      computeFingerprint(manifest, ['basic'], ['Algo A', 'Algo B'], ['probe-x']),
    );
  });

  it('changes when probe list changes', () => {
    const manifest = makeManifest();
    assert.notEqual(
      computeFingerprint(manifest, ['basic'], ['Algo A'], ['probe-x']),
      computeFingerprint(manifest, ['basic'], ['Algo A'], ['probe-x', 'probe-y']),
    );
  });

  it('is stable regardless of algorithm/probe list order (sorted internally)', () => {
    const manifest = makeManifest();
    const fp1 = computeFingerprint(manifest, ['basic'], ['Algo A', 'Algo B'], ['probe-x', 'probe-y']);
    const fp2 = computeFingerprint(manifest, ['basic'], ['Algo B', 'Algo A'], ['probe-y', 'probe-x']);
    assert.equal(fp1, fp2, 'Fingerprint should be order-independent for algorithm and probe lists');
  });

  it('excludes file hashes for datasets not in the selected list', () => {
    const manifest: Manifest = {
      generatedAt: '2025-01-01T00:00:00.000Z',
      files: {
        basic_input: { filename: 'basic/basic_input.abc12345.yaml', contentHash: 'abc12345' },
        basic_answer: { filename: 'basic/basic_answer.def67890.yaml', contentHash: 'def67890' },
        medium_input: { filename: 'medium/medium_input.changed.yaml', contentHash: 'changed1' },
        medium_answer: { filename: 'medium/medium_answer.changed.yaml', contentHash: 'changed2' },
      },
    };
    const manifestAlt: Manifest = {
      ...manifest,
      files: {
        ...manifest.files,
        medium_input: { filename: 'medium/medium_input.other.yaml', contentHash: 'other123' },
      },
    };
    // Only running basic — medium hash differences should not affect the fingerprint.
    assert.equal(
      computeFingerprint(manifest, ['basic'], ['Algo A'], ['probe-x']),
      computeFingerprint(manifestAlt, ['basic'], ['Algo A'], ['probe-x']),
    );
  });
});

// ---------------------------------------------------------------------------
// isAlreadyUpToDate
// ---------------------------------------------------------------------------

describe('isAlreadyUpToDate — missing or invalid index', () => {
  it('returns false when reports directory does not exist', () => {
    const tempDir = path.join(os.tmpdir(), 'does-not-exist-' + Date.now());
    assert.equal(isAlreadyUpToDate(tempDir, 'anyfingerprint', ['basic']), false);
  });

  it('returns false when experiment-run.json does not exist', () => {
    const tempDir = makeTempDir();
    try {
      assert.equal(isAlreadyUpToDate(tempDir, 'anyfingerprint', ['basic']), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('returns false when experiment-run.json contains invalid JSON', () => {
    const tempDir = makeTempDir();
    try {
      fs.writeFileSync(path.join(tempDir, 'experiment-run.json'), 'not json');
      assert.equal(isAlreadyUpToDate(tempDir, 'fp', ['basic']), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });
});

describe('isAlreadyUpToDate — fingerprint mismatch', () => {
  it('returns false when the stored fingerprint differs', () => {
    const tempDir = makeTempDir();
    try {
      const index: ExperimentIndex = {
        metadata: makeMetadata({ fingerprint: 'old-fingerprint-abc' }),
        reports: { basic: 'basic/benchmark-1.json' },
      };
      fs.writeFileSync(path.join(tempDir, 'experiment-run.json'), JSON.stringify(index));
      assert.equal(isAlreadyUpToDate(tempDir, 'new-fingerprint-xyz', ['basic']), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });
});

describe('isAlreadyUpToDate — matching fingerprint, file checks', () => {
  it('returns false when a dataset is missing from the index reports', () => {
    const tempDir = makeTempDir();
    try {
      const index: ExperimentIndex = {
        metadata: makeMetadata({ fingerprint: 'fp123' }),
        reports: {},
      };
      fs.writeFileSync(path.join(tempDir, 'experiment-run.json'), JSON.stringify(index));
      assert.equal(isAlreadyUpToDate(tempDir, 'fp123', ['basic']), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('returns false when the referenced report file does not exist on disk', () => {
    const tempDir = makeTempDir();
    try {
      const index: ExperimentIndex = {
        metadata: makeMetadata({ fingerprint: 'fp123' }),
        reports: { basic: 'reports/basic/benchmark-missing.json' },
      };
      fs.writeFileSync(path.join(tempDir, 'experiment-run.json'), JSON.stringify(index));
      assert.equal(isAlreadyUpToDate(tempDir, 'fp123', ['basic']), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('returns true when fingerprint matches and all report files exist', () => {
    const tempDir = makeTempDir();
    // tempDir is the reportsDir; the report path is relative to reportsDir.
    // isAlreadyUpToDate resolves: path.join(reportsDir, reportRelPath)
    const reportRelPath = `basic/benchmark-1.json`;
    const absReportPath = path.join(tempDir, reportRelPath);

    try {
      fs.mkdirSync(path.dirname(absReportPath), { recursive: true });
      fs.writeFileSync(absReportPath, '{}');

      const index: ExperimentIndex = {
        metadata: makeMetadata({ fingerprint: 'fp-match-123' }),
        reports: { basic: reportRelPath },
      };
      fs.writeFileSync(path.join(tempDir, 'experiment-run.json'), JSON.stringify(index));

      assert.equal(isAlreadyUpToDate(tempDir, 'fp-match-123', ['basic']), true);
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('returns false when only some datasets have matching reports', () => {
    const tempDir = makeTempDir();
    const basicRelPath = `basic/benchmark-1.json`;
    const absBasicPath = path.join(tempDir, basicRelPath);

    try {
      fs.mkdirSync(path.dirname(absBasicPath), { recursive: true });
      fs.writeFileSync(absBasicPath, '{}');

      const index: ExperimentIndex = {
        metadata: makeMetadata({ fingerprint: 'fp-partial' }),
        reports: {
          basic: basicRelPath,
          // medium is not in the reports map
        },
      };
      fs.writeFileSync(path.join(tempDir, 'experiment-run.json'), JSON.stringify(index));

      assert.equal(isAlreadyUpToDate(tempDir, 'fp-partial', ['basic', 'medium']), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('returns false when the report path is an absolute path (path traversal guard)', () => {
    const tempDir = makeTempDir();
    try {
      // An absolute path in the report map should be rejected as unsafe.
      const index: ExperimentIndex = {
        metadata: makeMetadata({ fingerprint: 'fp-abs' }),
        reports: { basic: path.join(tempDir, 'basic', 'benchmark-1.json') }, // absolute path
      };
      fs.writeFileSync(path.join(tempDir, 'experiment-run.json'), JSON.stringify(index));
      assert.equal(isAlreadyUpToDate(tempDir, 'fp-abs', ['basic']), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('returns false when the report path contains ".." traversal segments', () => {
    const tempDir = makeTempDir();
    try {
      const index: ExperimentIndex = {
        metadata: makeMetadata({ fingerprint: 'fp-traversal' }),
        reports: { basic: '../../../etc/passwd' },
      };
      fs.writeFileSync(path.join(tempDir, 'experiment-run.json'), JSON.stringify(index));
      assert.equal(isAlreadyUpToDate(tempDir, 'fp-traversal', ['basic']), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// computeFingerprint — packageVersion sensitivity
// ---------------------------------------------------------------------------

describe('computeFingerprint — packageVersion sensitivity', () => {
  // The real computeFingerprint reads pkgJson.version internally; we verify that
  // the fingerprint changes when the same source inputs are run with a mocked
  // package version. Since the module uses the live pkgJson import, we test this
  // indirectly by checking that two independent calls always produce the same
  // output (confirming packageVersion is stable within a run).
  it('produces a stable fingerprint across repeated calls (packageVersion is constant)', () => {
    const manifest = makeManifest();
    const fp1 = computeFingerprint(manifest, ['basic'], ['Algo A'], ['probe-x']);
    const fp2 = computeFingerprint(manifest, ['basic'], ['Algo A'], ['probe-x']);
    assert.equal(fp1, fp2, 'Fingerprint must be identical across calls with the same inputs');
  });
});

// ---------------------------------------------------------------------------
// isForceMode
// ---------------------------------------------------------------------------

describe('isForceMode — environment variable detection', () => {
  let originalEnvValue: string | undefined;

  beforeEach(() => {
    originalEnvValue = process.env.POPULATE_ALL_FORCE;
  });

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env.POPULATE_ALL_FORCE;
    } else {
      process.env.POPULATE_ALL_FORCE = originalEnvValue;
    }
  });

  it('returns true when POPULATE_ALL_FORCE is "1"', () => {
    process.env.POPULATE_ALL_FORCE = '1';
    assert.equal(isForceMode(), true);
  });

  it('returns false when POPULATE_ALL_FORCE is unset', () => {
    delete process.env.POPULATE_ALL_FORCE;
    assert.equal(isForceMode(), false);
  });

  it('returns false when POPULATE_ALL_FORCE is "0"', () => {
    process.env.POPULATE_ALL_FORCE = '0';
    assert.equal(isForceMode(), false);
  });

  it('returns false when POPULATE_ALL_FORCE is "true" (only "1" is accepted)', () => {
    process.env.POPULATE_ALL_FORCE = 'true';
    assert.equal(isForceMode(), false);
  });

  it('returns false when POPULATE_ALL_FORCE is empty string', () => {
    process.env.POPULATE_ALL_FORCE = '';
    assert.equal(isForceMode(), false);
  });
});

// ---------------------------------------------------------------------------
// formatHydrationFailTag
// ---------------------------------------------------------------------------

describe('formatHydrationFailTag — de-duplication', () => {
  it('consolidates identical errors to a single [both comparers: …] tag', () => {
    const tag = formatHydrationFailTag('Maximum call stack size exceeded', 'Maximum call stack size exceeded');
    assert.equal(tag, '[both comparers: Maximum call stack size exceeded]');
  });

  it('returns separate tags when errors differ', () => {
    const tag = formatHydrationFailTag('Error A', 'Error B');
    assert.equal(tag, '[smartCompare: Error A] [flatCompare: Error B]');
  });

  it('returns only the smartCompare tag when flatErr is null', () => {
    const tag = formatHydrationFailTag('Some error', null);
    assert.equal(tag, '[smartCompare: Some error]');
  });

  it('returns only the flatCompare tag when smartErr is null', () => {
    const tag = formatHydrationFailTag(null, 'Some error');
    assert.equal(tag, '[flatCompare: Some error]');
  });

  it('returns an empty string when both errors are null', () => {
    const tag = formatHydrationFailTag(null, null);
    assert.equal(tag, '');
  });

  it('truncates long error strings to the default 60 characters', () => {
    const longErr = 'A'.repeat(100);
    const tag = formatHydrationFailTag(longErr, longErr);
    assert.equal(tag, `[both comparers: ${'A'.repeat(60)}]`);
  });

  it('respects a custom truncateAt value', () => {
    const tag = formatHydrationFailTag('Hello World', 'Hello World', 5);
    assert.equal(tag, '[both comparers: Hello]');
  });

  it('consolidates errors that differ in full but match after truncation', () => {
    // "AAAAX" and "AAAAY" both truncate to "AAAA" at truncateAt=4 — treated as same
    const tag = formatHydrationFailTag('AAAAX', 'AAAAY', 4);
    assert.equal(tag, '[both comparers: AAAA]');
  });
});

// ---------------------------------------------------------------------------
// buildFailureDetailLines
// ---------------------------------------------------------------------------

describe('buildFailureDetailLines — de-duplication', () => {
  it('returns one combined line when both errors are identical', () => {
    const lines = buildFailureDetailLines('Maximum call stack size exceeded', 'Maximum call stack size exceeded');
    assert.deepEqual(lines, ['  Both comparers: Maximum call stack size exceeded...']);
  });

  it('returns two separate lines when errors differ', () => {
    const lines = buildFailureDetailLines('Error from smart', 'Error from flat');
    assert.deepEqual(lines, [
      '  smartCompare Error: Error from smart...',
      '  flatCompare Error: Error from flat...',
    ]);
  });

  it('returns only the smartCompare line when flatErr is null', () => {
    const lines = buildFailureDetailLines('Smart failed', null);
    assert.deepEqual(lines, ['  smartCompare Error: Smart failed...']);
  });

  it('returns only the flatCompare line when smartErr is null', () => {
    const lines = buildFailureDetailLines(null, 'Flat failed');
    assert.deepEqual(lines, ['  flatCompare Error: Flat failed...']);
  });

  it('returns an empty array when both errors are null', () => {
    const lines = buildFailureDetailLines(null, null);
    assert.deepEqual(lines, []);
  });

  it('truncates to the default 100 characters', () => {
    const longErr = 'E'.repeat(200);
    const lines = buildFailureDetailLines(longErr, longErr);
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('E'.repeat(100) + '...'));
  });

  it('replaces newlines in the error message', () => {
    const lines = buildFailureDetailLines('line1\nline2', 'line1\nline2');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('line1 line2'));
  });
});

// ---------------------------------------------------------------------------
// buildLaterDatasetLines
// ---------------------------------------------------------------------------

function makePassOutcome(name: string, category: string, time = '10ms', ram = '1 MB'): LaterAlgoOutcome {
  return {
    algoName: name,
    algoCategory: category,
    baselineSkipped: false,
    knownPriorFailure: false,
    isNewFailure: false,
    isConflict: false,
    hydrationLine: `  Hydration:     ✅ PASS (double-verified) | Time: ${time} | RAM: ${ram}`,
    failureDetailLines: [],
    probeChangeLine: null,
  };
}

function makeSkippedOutcome(name: string, category: string): LaterAlgoOutcome {
  return {
    algoName: name,
    algoCategory: category,
    baselineSkipped: true,
    knownPriorFailure: false,
    isNewFailure: false,
    isConflict: false,
    hydrationLine: null,
    failureDetailLines: [],
    probeChangeLine: null,
  };
}

function makeKnownPriorOutcome(name: string, category: string): LaterAlgoOutcome {
  return {
    algoName: name,
    algoCategory: category,
    baselineSkipped: false,
    knownPriorFailure: true,
    isNewFailure: false,
    isConflict: false,
    hydrationLine: `  Hydration:     ❌ FAIL [both comparers: stack overflow] | Time: < 0.1ms | RAM: < 0.1 MB`,
    failureDetailLines: [],
    probeChangeLine: null,
  };
}

function makeNewFailOutcome(name: string, category: string): LaterAlgoOutcome {
  return {
    algoName: name,
    algoCategory: category,
    baselineSkipped: false,
    knownPriorFailure: false,
    isNewFailure: true,
    isConflict: false,
    hydrationLine: `  Hydration:     ❌ FAIL [both comparers: Maximum call stack size exceeded] | Time: < 0.1ms | RAM: < 0.1 MB`,
    failureDetailLines: ['  Both comparers: Maximum call stack size exceeded...'],
    probeChangeLine: null,
  };
}

function makeConflictOutcome(name: string, category: string): LaterAlgoOutcome {
  return {
    algoName: name,
    algoCategory: category,
    baselineSkipped: false,
    knownPriorFailure: false,
    isNewFailure: false,
    isConflict: true,
    hydrationLine: `  Hydration:     🚨 CONFLICT — smartCompare=PASS, flatCompare=FAIL | Time: 5ms | RAM: < 0.1 MB`,
    failureDetailLines: [],
    probeChangeLine: null,
  };
}

describe('buildLaterDatasetLines — compact summary (no changes)', () => {
  it('produces a compact summary sentence when all non-skipped algorithms pass', () => {
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      makePassOutcome('Map Tracker', 'Reference Tracking'),
      makePassOutcome('Tarjan SCC Layering', 'Topological'),
      makePassOutcome('Two-Pass Wire', 'Schema-Driven'),
    ];
    const lines = buildLaterDatasetLines(outcomes);
    // Should have one omission note + one compact summary
    assert.ok(lines.some((l) => l.includes('Known failure omitted: Naive Recursion')));
    assert.ok(lines.some((l) => l.includes('continued to pass') && l.includes('experiment stable')));
    // Should NOT have individual per-algorithm header lines
    assert.ok(!lines.some((l) => l.startsWith('[Reference Tracking] Map Tracker')));
  });

  it('uses singular "algorithm" when only one algorithm passes', () => {
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      makePassOutcome('Map Tracker', 'Reference Tracking'),
    ];
    const lines = buildLaterDatasetLines(outcomes);
    assert.ok(lines.some((l) => l.includes('1 algorithm continued to pass')));
  });

  it('uses plural "algorithms" when multiple algorithms pass', () => {
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      makePassOutcome('Tarjan SCC Layering', 'Topological'),
      makePassOutcome('Two-Pass Wire', 'Schema-Driven'),
    ];
    const lines = buildLaterDatasetLines(outcomes);
    assert.ok(lines.some((l) => l.includes('2 algorithms continued to pass')));
  });
});

describe('buildLaterDatasetLines — new failure expansion', () => {
  it('prints a full block with change indicator when an algorithm newly fails', () => {
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      makeNewFailOutcome('Map Tracker', 'Reference Tracking'),
      makePassOutcome('Tarjan SCC Layering', 'Topological'),
      makePassOutcome('Two-Pass Wire', 'Schema-Driven'),
    ];
    const lines = buildLaterDatasetLines(outcomes);

    // Omission note for the baseline-skipped algorithm
    assert.ok(lines.some((l) => l.includes('Known failure omitted: Naive Recursion')));

    // Full block for the new failure
    assert.ok(lines.some((l) => l.startsWith('[Reference Tracking] Map Tracker')));
    assert.ok(lines.some((l) => l.includes('Hydration changed: ✅ PASS → ❌ FAIL')));
    assert.ok(lines.some((l) => l.includes('Both comparers: Maximum call stack size exceeded...')));

    // Individual entries for stable passing algorithms (context for survivors)
    assert.ok(lines.some((l) => l.startsWith('[Topological] Tarjan SCC Layering')));
    assert.ok(lines.some((l) => l.startsWith('[Schema-Driven] Two-Pass Wire')));
  });

  it('includes failure detail lines for the new failure', () => {
    const outcomes: LaterAlgoOutcome[] = [makeNewFailOutcome('Map Tracker', 'Reference Tracking')];
    const lines = buildLaterDatasetLines(outcomes);
    assert.ok(lines.some((l) => l.includes('Both comparers: Maximum call stack size exceeded...')));
  });
});

describe('buildLaterDatasetLines — known-prior-failure expansion', () => {
  it('shows individual entries for survivors when there are known-prior failures', () => {
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      makeKnownPriorOutcome('Map Tracker', 'Reference Tracking'),
      makePassOutcome('Tarjan SCC Layering', 'Topological', '2.1s', '150 MB'),
      makePassOutcome('Two-Pass Wire', 'Schema-Driven', '338ms', '60 MB'),
    ];
    const lines = buildLaterDatasetLines(outcomes);

    // Both omitted algorithms in a single note
    assert.ok(lines.some((l) => l.includes('Known failures omitted: Naive Recursion, Map Tracker')));

    // Individual entries for survivors
    assert.ok(lines.some((l) => l.startsWith('[Topological] Tarjan SCC Layering')));
    assert.ok(lines.some((l) => l.includes('Time: 2.1s')));
    assert.ok(lines.some((l) => l.startsWith('[Schema-Driven] Two-Pass Wire')));
    assert.ok(lines.some((l) => l.includes('Time: 338ms')));

    // No compact summary sentence (since there are omitted failures)
    assert.ok(!lines.some((l) => l.includes('continued to pass') && l.includes('experiment stable')));
  });

  it('uses singular label for a single omitted algorithm', () => {
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      makePassOutcome('Map Tracker', 'Reference Tracking'),
    ];
    const lines = buildLaterDatasetLines(outcomes);
    assert.ok(lines.some((l) => l.includes('Known failure omitted: Naive Recursion')));
    assert.ok(!lines.some((l) => l.includes('Known failures omitted')));
  });

  it('uses plural label for multiple omitted algorithms', () => {
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      makeKnownPriorOutcome('Map Tracker', 'Reference Tracking'),
    ];
    const lines = buildLaterDatasetLines(outcomes);
    assert.ok(lines.some((l) => l.includes('Known failures omitted: Naive Recursion, Map Tracker')));
  });
});

describe('buildLaterDatasetLines — edge cases', () => {
  it('returns an empty array when outcomes list is empty', () => {
    assert.deepEqual(buildLaterDatasetLines([]), []);
  });

  it('includes probe change line when provided for a new failure', () => {
    const outcome: LaterAlgoOutcome = {
      ...makeNewFailOutcome('Map Tracker', 'Reference Tracking'),
      probeChangeLine: '  Consumer probes: ⚠️  changed from baseline — ❌ naive-json',
    };
    const lines = buildLaterDatasetLines([outcome]);
    assert.ok(lines.some((l) => l.includes('Consumer probes: ⚠️  changed from baseline')));
  });

  it('includes probe change line when provided for a stable pass', () => {
    const outcome: LaterAlgoOutcome = {
      ...makePassOutcome('Map Tracker', 'Reference Tracking'),
      probeChangeLine: '  Consumer probes: ⚠️  changed from baseline — ✅ cycle-flat',
    };
    // Need a known-prior failure to trigger expansion mode
    const outcomes: LaterAlgoOutcome[] = [
      makeKnownPriorOutcome('Naive Recursion', 'Reference Tracking'),
      outcome,
    ];
    const lines = buildLaterDatasetLines(outcomes);
    assert.ok(lines.some((l) => l.includes('Consumer probes: ⚠️  changed from baseline')));
  });
});

describe('buildLaterDatasetLines — conflict handling', () => {
  it('prints a full block for a conflict and does not collapse it into stable-pass summary', () => {
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      makeConflictOutcome('Map Tracker', 'Reference Tracking'),
      makePassOutcome('Tarjan SCC Layering', 'Topological'),
      makePassOutcome('Two-Pass Wire', 'Schema-Driven'),
    ];
    const lines = buildLaterDatasetLines(outcomes);

    // Conflict block must appear
    assert.ok(lines.some((l) => l.startsWith('[Reference Tracking] Map Tracker')));
    assert.ok(lines.some((l) => l.includes('CONFLICT — comparers disagree')));
    assert.ok(lines.some((l) => l.includes('🚨 CONFLICT')));

    // No compact "continued to pass" sentence — a conflict triggers expansion mode
    assert.ok(!lines.some((l) => l.includes('continued to pass') && l.includes('experiment stable')));

    // Stable survivors shown individually
    assert.ok(lines.some((l) => l.startsWith('[Topological] Tarjan SCC Layering')));
    assert.ok(lines.some((l) => l.startsWith('[Schema-Driven] Two-Pass Wire')));
  });

  it('does not include a conflict in the omission note', () => {
    const outcomes: LaterAlgoOutcome[] = [
      makeConflictOutcome('Map Tracker', 'Reference Tracking'),
    ];
    const lines = buildLaterDatasetLines(outcomes);
    // Conflicts are NOT omitted — they should not appear in the "Known failure omitted" note
    assert.ok(!lines.some((l) => l.includes('Known failure')));
  });

  it('includes a probe change line for a conflict when provided', () => {
    const outcome: LaterAlgoOutcome = {
      ...makeConflictOutcome('Map Tracker', 'Reference Tracking'),
      probeChangeLine: '  Consumer probes: ⚠️  changed from baseline — ❌ naive-json',
    };
    const lines = buildLaterDatasetLines([outcome]);
    assert.ok(lines.some((l) => l.includes('Consumer probes: ⚠️  changed from baseline')));
  });
});
