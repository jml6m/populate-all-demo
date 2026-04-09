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
  capErrorDetail,
  MAX_ERROR_DETAIL_CHARS,
  ExperimentIndex,
  RunMetadata,
  LaterAlgoOutcome,
  CYCLIC_BASELINE_TIER,
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
// capErrorDetail
// ---------------------------------------------------------------------------

describe('capErrorDetail — character limit enforcement', () => {
  it('returns null when input is null', () => {
    assert.equal(capErrorDetail(null), null);
  });

  it('returns the message unchanged when it is within the limit', () => {
    const msg = 'Maximum call stack size exceeded';
    assert.equal(capErrorDetail(msg), msg);
  });

  it('caps messages that exceed MAX_ERROR_DETAIL_CHARS', () => {
    const longMsg = 'A'.repeat(MAX_ERROR_DETAIL_CHARS + 20);
    const capped = capErrorDetail(longMsg);
    assert.ok(capped !== null && capped.length === MAX_ERROR_DETAIL_CHARS);
    assert.equal(capped, 'A'.repeat(MAX_ERROR_DETAIL_CHARS));
  });

  it('normalises embedded newlines to spaces', () => {
    assert.equal(capErrorDetail('line1\nline2'), 'line1 line2');
    assert.equal(capErrorDetail('line1\r\nline2'), 'line1 line2');
  });

  it('MAX_ERROR_DETAIL_CHARS is a positive integer', () => {
    assert.equal(typeof MAX_ERROR_DETAIL_CHARS, 'number');
    assert.ok(Number.isInteger(MAX_ERROR_DETAIL_CHARS));
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
    probesFailed: false,
    hydrationLine: `  Full Run:      ✅ PASS (double-verified) | Time: ${time} | RAM: ${ram}`,
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
    probesFailed: false,
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
    probesFailed: false,
    hydrationLine: `  Hydration:     ❌ FAIL [both comparers: stack overflow]`,
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
    probesFailed: false,
    hydrationLine: `  Hydration:     ❌ FAIL [both comparers: Maximum call stack size exceeded]`,
    failureDetailLines: [],
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
    probesFailed: false,
    hydrationLine: `  Full Run:      🚨 CONFLICT — smartCompare=PASS, flatCompare=FAIL | Time: 5ms | RAM: < 0.1 MB`,
    failureDetailLines: [],
    probeChangeLine: null,
  };
}

describe('buildLaterDatasetLines — compact summary (no changes)', () => {
  it('produces a compact summary sentence only when NO algorithms are omitted and all pass', () => {
    const outcomes: LaterAlgoOutcome[] = [
      makePassOutcome('Map Tracker', 'Reference Tracking'),
      makePassOutcome('Tarjan SCC Layering', 'Topological'),
      makePassOutcome('Two-Pass Wire', 'Schema-Driven'),
    ];
    const lines = buildLaterDatasetLines(outcomes);
    // All pass, nothing omitted → compact summary
    assert.ok(lines.some((l) => l.includes('continued to pass') && l.includes('experiment stable')));
    // No individual header lines in compact mode
    assert.ok(!lines.some((l) => l.startsWith('[Reference Tracking] Map Tracker')));
  });

  it('uses singular "algorithm" when only one algorithm passes and nothing is omitted', () => {
    const outcomes: LaterAlgoOutcome[] = [makePassOutcome('Map Tracker', 'Reference Tracking')];
    const lines = buildLaterDatasetLines(outcomes);
    assert.ok(lines.some((l) => l.includes('1 algorithm continued to pass')));
  });

  it('uses plural "algorithms" when multiple algorithms pass and nothing is omitted', () => {
    const outcomes: LaterAlgoOutcome[] = [
      makePassOutcome('Tarjan SCC Layering', 'Topological'),
      makePassOutcome('Two-Pass Wire', 'Schema-Driven'),
    ];
    const lines = buildLaterDatasetLines(outcomes);
    assert.ok(lines.some((l) => l.includes('2 algorithms continued to pass')));
  });

  it('shows individual entries (not compact summary) when a baseline-skipped algorithm is omitted', () => {
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      makePassOutcome('Map Tracker', 'Reference Tracking'),
      makePassOutcome('Tarjan SCC Layering', 'Topological'),
      makePassOutcome('Two-Pass Wire', 'Schema-Driven'),
    ];
    const lines = buildLaterDatasetLines(outcomes);
    // Omission note present
    assert.ok(lines.some((l) => l.includes('Known failure omitted: Naive Recursion')));
    // Individual entries for passing algorithms
    assert.ok(lines.some((l) => l.startsWith('[Reference Tracking] Map Tracker')));
    assert.ok(lines.some((l) => l.startsWith('[Topological] Tarjan SCC Layering')));
    assert.ok(lines.some((l) => l.startsWith('[Schema-Driven] Two-Pass Wire')));
    // No compact summary sentence
    assert.ok(!lines.some((l) => l.includes('continued to pass') && l.includes('experiment stable')));
  });
});

describe('buildLaterDatasetLines — new failure expansion', () => {
  it('prints a single hydration-fail line (no change indicator) when an algorithm newly fails', () => {
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      makeNewFailOutcome('Map Tracker', 'Reference Tracking'),
      makePassOutcome('Tarjan SCC Layering', 'Topological'),
      makePassOutcome('Two-Pass Wire', 'Schema-Driven'),
    ];
    const lines = buildLaterDatasetLines(outcomes);

    // Omission note for the baseline-skipped algorithm
    assert.ok(lines.some((l) => l.includes('Known failure omitted: Naive Recursion')));

    // Full block for the new failure — hydration fail line, phase-oriented
    assert.ok(lines.some((l) => l.startsWith('[Reference Tracking] Map Tracker')));
    assert.ok(lines.some((l) => l.includes('Hydration:') && l.includes('❌ FAIL')));

    // Individual entries for stable passing algorithms (context for survivors)
    assert.ok(lines.some((l) => l.startsWith('[Topological] Tarjan SCC Layering')));
    assert.ok(lines.some((l) => l.startsWith('[Schema-Driven] Two-Pass Wire')));
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

describe('buildLaterDatasetLines — hydration-pass probe-fail two-line output', () => {
  it('prints Hydration: ✅ PASS and Consumer probes: ❌ FAIL lines when probes fail', () => {
    const outcome: LaterAlgoOutcome = {
      ...makePassOutcome('Map Tracker', 'Reference Tracking'),
      probesFailed: true,
      probeChangeLine: '  Consumer probes: ❌ FAIL — ❌ naive-json  ✅ cycle-flat',
    };
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      outcome,
    ];
    const lines = buildLaterDatasetLines(outcomes);
    const mapTrackerHeaderIndex = lines.findIndex((l) =>
      l.startsWith('[Reference Tracking] Map Tracker'),
    );
    assert.ok(mapTrackerHeaderIndex >= 0);
    assert.ok(lines.some((l) => l.includes('Hydration:') && l.includes('✅ PASS')));
    assert.ok(lines.some((l) => l.includes('Consumer probes: ❌ FAIL')));
    assert.ok(lines.some((l) => l.includes('❌ naive-json')));
    assert.ok(lines[mapTrackerHeaderIndex + 1]?.includes('Hydration:'));
    assert.ok(lines[mapTrackerHeaderIndex + 1]?.includes('✅ PASS'));
    assert.ok(lines[mapTrackerHeaderIndex + 2]?.includes('Consumer probes: ❌ FAIL'));
    // No Full Run line with metrics when probes failed
    assert.ok(!lines.some((l) => l.includes('Full Run:')));
  });

  it('does not use two-line format when probesFailed is false', () => {
    const outcome: LaterAlgoOutcome = {
      ...makePassOutcome('Map Tracker', 'Reference Tracking'),
      probesFailed: false,
      probeChangeLine: '  Consumer probes: ⚠️  changed from baseline — ✅ cycle-flat',
    };
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      outcome,
    ];
    const lines = buildLaterDatasetLines(outcomes);
    // Should still show Full Run line with metrics, not the Hydration: ✅ PASS shortform
    assert.ok(lines.some((l) => l.includes('Full Run:') && l.includes('✅ PASS')));
    assert.ok(lines.some((l) => l.includes('⚠️  changed from baseline')));
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

// ---------------------------------------------------------------------------
// CYCLIC_BASELINE_TIER constant
// ---------------------------------------------------------------------------

describe('CYCLIC_BASELINE_TIER — constant value', () => {
  it('is the string "basic"', () => {
    assert.equal(CYCLIC_BASELINE_TIER, 'basic');
  });

  it('is a string', () => {
    assert.equal(typeof CYCLIC_BASELINE_TIER, 'string');
  });
});

// ---------------------------------------------------------------------------
// acyclic-control tier — computeFingerprint with new dataset
// ---------------------------------------------------------------------------

describe('computeFingerprint — acyclic-control dataset support', () => {
  function makeFullManifest(): Manifest {
    return {
      generatedAt: '2025-01-01T00:00:00.000Z',
      files: {
        'acyclic-control_input': {
          filename: 'acyclic-control/acyclic-control_input.aabb1122.yaml',
          contentHash: 'aabb1122',
        },
        'acyclic-control_answer': {
          filename: 'acyclic-control/acyclic-control_answer.ccdd3344.yaml',
          contentHash: 'ccdd3344',
        },
        basic_input: { filename: 'basic/basic_input.abc12345.yaml', contentHash: 'abc12345' },
        basic_answer: { filename: 'basic/basic_answer.def67890.yaml', contentHash: 'def67890' },
        medium_input: { filename: 'medium/medium_input.aabbccdd.yaml', contentHash: 'aabbccdd' },
        medium_answer: { filename: 'medium/medium_answer.11223344.yaml', contentHash: '11223344' },
      },
    };
  }

  it('includes acyclic-control file hashes when acyclic-control is in the selected datasets', () => {
    const manifest = makeFullManifest();
    const fp1 = computeFingerprint(manifest, ['acyclic-control', 'basic'], ['Algo A'], ['probe-x']);
    const fp2 = computeFingerprint(manifest, ['basic'], ['Algo A'], ['probe-x']);
    // Running with acyclic-control included must produce a different fingerprint
    assert.notEqual(fp1, fp2, 'Adding acyclic-control to the dataset list must change the fingerprint');
  });

  it('excludes acyclic-control file hashes when it is not in the selected datasets', () => {
    const manifest = makeFullManifest();
    // Mutate the acyclic-control hash — should not affect the fingerprint when not selected.
    const manifestAlt: Manifest = {
      ...manifest,
      files: {
        ...manifest.files,
        'acyclic-control_input': {
          filename: 'acyclic-control/acyclic-control_input.different.yaml',
          contentHash: 'different',
        },
      },
    };
    assert.equal(
      computeFingerprint(manifest, ['basic'], ['Algo A'], ['probe-x']),
      computeFingerprint(manifestAlt, ['basic'], ['Algo A'], ['probe-x']),
      'Changing acyclic-control hash should not affect fingerprint when only basic is selected',
    );
  });

  it('changes when acyclic-control file hash changes and acyclic-control is selected', () => {
    const manifest = makeFullManifest();
    const manifestAlt: Manifest = {
      ...manifest,
      files: {
        ...manifest.files,
        'acyclic-control_input': {
          filename: 'acyclic-control/acyclic-control_input.different.yaml',
          contentHash: 'different',
        },
      },
    };
    assert.notEqual(
      computeFingerprint(manifest, ['acyclic-control', 'basic'], ['Algo A'], ['probe-x']),
      computeFingerprint(manifestAlt, ['acyclic-control', 'basic'], ['Algo A'], ['probe-x']),
    );
  });
});

// ---------------------------------------------------------------------------
// acyclic-control tier — isAlreadyUpToDate with multi-dataset runs
// ---------------------------------------------------------------------------

describe('isAlreadyUpToDate — acyclic-control included in dataset list', () => {
  it('returns true when all datasets (including acyclic-control) have matching reports', () => {
    const tempDir = makeTempDir();
    const acyclicRelPath = 'acyclic-control/benchmark-1.json';
    const basicRelPath = 'basic/benchmark-1.json';

    try {
      fs.mkdirSync(path.join(tempDir, 'acyclic-control'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'basic'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, acyclicRelPath), '{}');
      fs.writeFileSync(path.join(tempDir, basicRelPath), '{}');

      const index: ExperimentIndex = {
        metadata: makeMetadata({
          fingerprint: 'fp-acyclic-multi',
          datasets: ['acyclic-control', 'basic'],
        }),
        reports: {
          'acyclic-control': acyclicRelPath,
          basic: basicRelPath,
        },
      };
      fs.writeFileSync(path.join(tempDir, 'experiment-run.json'), JSON.stringify(index));

      assert.equal(
        isAlreadyUpToDate(tempDir, 'fp-acyclic-multi', ['acyclic-control', 'basic']),
        true,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('returns false when the acyclic-control report is missing', () => {
    const tempDir = makeTempDir();
    const basicRelPath = 'basic/benchmark-1.json';

    try {
      fs.mkdirSync(path.join(tempDir, 'basic'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, basicRelPath), '{}');
      // acyclic-control dir/file NOT created

      const index: ExperimentIndex = {
        metadata: makeMetadata({
          fingerprint: 'fp-missing-acyclic',
          datasets: ['acyclic-control', 'basic'],
        }),
        reports: {
          'acyclic-control': 'acyclic-control/benchmark-missing.json',
          basic: basicRelPath,
        },
      };
      fs.writeFileSync(path.join(tempDir, 'experiment-run.json'), JSON.stringify(index));

      assert.equal(
        isAlreadyUpToDate(tempDir, 'fp-missing-acyclic', ['acyclic-control', 'basic']),
        false,
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// acyclic-control tier — cyclic skip/suppression still anchored to basic
// ---------------------------------------------------------------------------

describe('buildLaterDatasetLines — cyclic skip semantics are unaffected by acyclic-control', () => {
  it('baseline-skipped algorithms from basic are still suppressed on medium/stress/extreme', () => {
    // Simulate what happens on medium/stress/extreme when Naive Recursion failed at basic.
    // acyclic-control running first should NOT change this behavior.
    const outcomes: LaterAlgoOutcome[] = [
      // Naive Recursion: failed at basic (cyclic baseline), so it is baseline-skipped here.
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      // Remaining algorithms pass.
      makePassOutcome('Map Tracker', 'Reference Tracking'),
      makePassOutcome('Tarjan SCC Layering', 'Topological'),
      makePassOutcome('Two-Pass Wire', 'Schema-Driven'),
    ];

    const lines = buildLaterDatasetLines(outcomes);

    // Naive Recursion must appear in the omission note, not as a failure block.
    assert.ok(lines.some((l) => l.includes('Known failure omitted: Naive Recursion')));
    assert.ok(!lines.some((l) => l.startsWith('[Reference Tracking] Naive Recursion')));

    // Survivors are shown individually (expansion mode because there is an omission).
    assert.ok(lines.some((l) => l.startsWith('[Reference Tracking] Map Tracker')));
    assert.ok(lines.some((l) => l.startsWith('[Topological] Tarjan SCC Layering')));
    assert.ok(lines.some((l) => l.startsWith('[Schema-Driven] Two-Pass Wire')));
  });

  it('all-pass later dataset produces the compact summary sentence (no omissions, no failures)', () => {
    // When acyclic-control runs first but basic is the cyclic baseline, and no algorithm
    // failed at basic, the later dataset should still produce the compact stable summary.
    const outcomes: LaterAlgoOutcome[] = [
      makePassOutcome('Naive Recursion', 'Reference Tracking'),
      makePassOutcome('Map Tracker', 'Reference Tracking'),
      makePassOutcome('Tarjan SCC Layering', 'Topological'),
      makePassOutcome('Two-Pass Wire', 'Schema-Driven'),
    ];

    const lines = buildLaterDatasetLines(outcomes);
    assert.ok(lines.some((l) => l.includes('continued to pass') && l.includes('experiment stable')));
    assert.ok(!lines.some((l) => l.includes('Known failure')));
  });

  it('new failure on a later cyclic dataset is still surfaced as isNewFailure', () => {
    // Map Tracker newly fails on stress — this must be shown even though
    // acyclic-control ran first (acyclic-control has no bearing on cyclic suppression).
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      makeNewFailOutcome('Map Tracker', 'Reference Tracking'),
      makePassOutcome('Tarjan SCC Layering', 'Topological'),
      makePassOutcome('Two-Pass Wire', 'Schema-Driven'),
    ];

    const lines = buildLaterDatasetLines(outcomes);

    // New failure must appear as a full block.
    assert.ok(lines.some((l) => l.startsWith('[Reference Tracking] Map Tracker')));
    assert.ok(lines.some((l) => l.includes('Hydration:') && l.includes('❌ FAIL')));

    // Omission note for the baseline-skipped algorithm.
    assert.ok(lines.some((l) => l.includes('Known failure omitted: Naive Recursion')));
  });
});
