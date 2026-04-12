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
  buildFullRunLine,
  cleanDatasetReports,
  capErrorDetail,
  MAX_ERROR_DETAIL_CHARS,
  ExperimentIndex,
  RunMetadata,
  LaterAlgoOutcome,
  CYCLIC_BASELINE_TIER,
  classifyHydrationFailTag,
  buildDetailHydrationLine,
  buildDetailConsumerProbesLine,
  buildDetailFullRunLine,
  normalizeFullDetailPhaseState,
  renderFullDetailLines,
} from './runner';
import type { Manifest } from './types';

const LOGS_DIR = path.resolve(__dirname, '..', 'logs');

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
  it('prints hydration-fail line AND consumer probes "not run" line when an algorithm newly fails', () => {
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      makeNewFailOutcome('Map Tracker', 'Reference Tracking'),
      makePassOutcome('Tarjan SCC Layering', 'Topological'),
      makePassOutcome('Two-Pass Wire', 'Schema-Driven'),
    ];
    const lines = buildLaterDatasetLines(outcomes);

    // Omission note for the baseline-skipped algorithm
    assert.ok(lines.some((l) => l.includes('Known failure omitted: Naive Recursion')));

    // Full block for the new failure — hydration fail line + consumer probes line
    assert.ok(lines.some((l) => l.startsWith('[Reference Tracking] Map Tracker')));
    assert.ok(lines.some((l) => l.includes('Hydration:') && l.includes('❌ FAIL')));
    // Consumer probes status must appear for new failures (phase-explicit)
    assert.ok(lines.some((l) => l.includes('Consumer probes: not run (hydration failed)')));

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
  it('prints two-line format when cycle-flat (authoritative probe) fails', () => {
    // probesFailed = true only when cycle-flat (authoritative probe) fails.
    // In this scenario naive-json passes but cycle-flat fails — the experiment is not a Full Run pass.
    const outcome: LaterAlgoOutcome = {
      ...makePassOutcome('Map Tracker', 'Reference Tracking'),
      probesFailed: true,
      probeChangeLine: '  Consumer probes: ❌ FAIL — ✅ naive-json  ❌ cycle-flat',
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
    assert.ok(lines.some((l) => l.includes('❌ cycle-flat')));
    assert.ok(lines[mapTrackerHeaderIndex + 1]?.includes('Hydration:'));
    assert.ok(lines[mapTrackerHeaderIndex + 1]?.includes('✅ PASS'));
    assert.ok(lines[mapTrackerHeaderIndex + 2]?.includes('Consumer probes: ❌ FAIL'));
    // No Full Run line with metrics when the authoritative probe failed
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

  it('shows Full Run: ✅ PASS even when naive-json fails, as long as cycle-flat passes (probesFailed is false)', () => {
    // This is the key semantic: naive-json failure on cyclic graphs is expected and informational.
    // cycle-flat passing means the experiment is a Full Run pass — no two-line format.
    const outcome: LaterAlgoOutcome = {
      ...makePassOutcome('Map Tracker', 'Reference Tracking'),
      probesFailed: false, // cycle-flat passed; naive-json failure is not authoritative
      probeChangeLine: null, // probe fingerprint unchanged from baseline; no change line
    };
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      outcome,
    ];
    const lines = buildLaterDatasetLines(outcomes);

    // Must show Full Run PASS with metrics (not the two-line phase format)
    const mapTrackerHeaderIdx = lines.findIndex((l) => l.startsWith('[Reference Tracking] Map Tracker'));
    assert.ok(mapTrackerHeaderIdx >= 0);
    assert.ok(lines[mapTrackerHeaderIdx + 1]?.includes('Full Run:'));
    assert.ok(lines[mapTrackerHeaderIdx + 1]?.includes('✅ PASS'));

    // Must NOT show the "Hydration: ✅ PASS" two-line phase indicator
    assert.ok(!lines.some((l) => l === '  Hydration:     ✅ PASS'));

    // Must NOT show a "Consumer probes: ❌ FAIL" label (naive-json failure is not a headline failure)
    assert.ok(!lines.some((l) => l.includes('Consumer probes: ❌ FAIL')));
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
// buildFullRunLine — hydration display line label semantics
// ---------------------------------------------------------------------------

describe('buildFullRunLine — hydration failure uses Hydration: label (not Full Run:)', () => {
  it('returns "Hydration: ❌ FAIL" when hydration failed (bothPass=false)', () => {
    const line = buildFullRunLine(
      false, // bothPass
      false, // endToEndPass
      '❌ FAIL [both comparers: Maximum call stack size exceeded]',
      4.1,
      1.4,
    );
    assert.ok(line.startsWith('  Hydration:'), `Expected "Hydration:" prefix, got: ${line}`);
    assert.ok(line.includes('❌ FAIL'));
    assert.ok(!line.includes('Full Run:'));
    assert.ok(!line.includes('Time:'), 'Hydration failure must not include timing metrics');
    assert.ok(!line.includes('RAM:'), 'Hydration failure must not include RAM metrics');
  });

  it('returns "Hydration: ❌ FAIL" without metrics even though timing args are provided', () => {
    const line = buildFullRunLine(false, false, '❌ FAIL [both comparers: stack overflow]', 10, 2);
    assert.ok(!line.includes('10'));
    assert.ok(!line.includes('2 MB'));
  });
});

describe('buildFullRunLine — full-run pass uses Full Run: label with headline metrics', () => {
  it('returns "Full Run: ✅ PASS" with Time and RAM when endToEndPass=true', () => {
    const line = buildFullRunLine(
      true,  // bothPass
      true,  // endToEndPass
      '✅ PASS (double-verified)',
      1.8,
      0.05,
    );
    assert.ok(line.startsWith('  Full Run:'), `Expected "Full Run:" prefix, got: ${line}`);
    assert.ok(line.includes('✅ PASS (double-verified)'));
    assert.ok(line.includes('Time:'));
    assert.ok(line.includes('RAM:'));
    assert.ok(!line.includes('Hydration:'));
  });

  it('includes formatted headline time in the Full Run line', () => {
    const line = buildFullRunLine(true, true, '✅ PASS (double-verified)', 22.5, 9.1);
    assert.ok(line.includes('23ms'), `Expected "23ms" (rounded), got: ${line}`);
  });
});

describe('buildFullRunLine — hydration pass + authoritative probe fail uses Hydration: ✅ PASS', () => {
  it('returns "Hydration: ✅ PASS" (no metrics) when hydration passed but endToEndPass=false', () => {
    // This happens when hydration passes but cycle-flat (authoritative probe) failed.
    const line = buildFullRunLine(
      true,  // bothPass — hydration passed
      false, // endToEndPass — cycle-flat failed
      '✅ PASS (double-verified)',
      5.0,
      2.0,
    );
    assert.equal(line, '  Hydration:     ✅ PASS');
    assert.ok(!line.includes('Full Run:'));
    assert.ok(!line.includes('Time:'));
    assert.ok(!line.includes('RAM:'));
  });
});

// ---------------------------------------------------------------------------
// cleanDatasetReports — stale benchmark file cleanup
// ---------------------------------------------------------------------------

describe('cleanDatasetReports — deletes stale benchmark files', () => {
  it('returns 0 when the directory does not exist', () => {
    const nonExistent = path.join(os.tmpdir(), 'non-existent-dir-' + Date.now());
    assert.equal(cleanDatasetReports(nonExistent), 0);
  });

  it('deletes all benchmark-<timestamp>.json files and returns count', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'benchmark-1000.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'benchmark-2000.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'benchmark-3000.json'), '{}');

      const deleted = cleanDatasetReports(tmpDir);
      assert.equal(deleted, 3);
      assert.deepEqual(fs.readdirSync(tmpDir), []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('does not delete non-benchmark files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'benchmark-1000.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'other-file.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'experiment-run.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'benchmark-abc.json'), '{}'); // non-numeric timestamp

      const deleted = cleanDatasetReports(tmpDir);
      assert.equal(deleted, 1); // only benchmark-1000.json matched
      const remaining = fs.readdirSync(tmpDir).sort();
      assert.deepEqual(remaining, ['benchmark-abc.json', 'experiment-run.json', 'other-file.json']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns 0 when directory is empty', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-test-'));
    try {
      assert.equal(cleanDatasetReports(tmpDir), 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns 0 when no benchmark files exist (only other files)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'experiment-run.json'), '{}');
      assert.equal(cleanDatasetReports(tmpDir), 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('preserves the keepFilename file and deletes all other benchmark files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'benchmark-1000.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'benchmark-2000.json'), '{}');
      fs.writeFileSync(path.join(tmpDir, 'benchmark-3000.json'), '{}'); // the "new" file to keep

      const deleted = cleanDatasetReports(tmpDir, 'benchmark-3000.json');
      assert.equal(deleted, 2);
      const remaining = fs.readdirSync(tmpDir);
      assert.deepEqual(remaining, ['benchmark-3000.json']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('returns 0 when only the keepFilename file exists', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'benchmark-5000.json'), '{}');
      assert.equal(cleanDatasetReports(tmpDir, 'benchmark-5000.json'), 0);
      assert.deepEqual(fs.readdirSync(tmpDir), ['benchmark-5000.json']);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});


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

// ---------------------------------------------------------------------------
// classifyHydrationFailTag — error classification
// ---------------------------------------------------------------------------

describe('classifyHydrationFailTag — stack overflow', () => {
  it('returns bracket-tag format for stack overflow errors', () => {
    const result = classifyHydrationFailTag(
      'Maximum call stack size exceeded',
      'Maximum call stack size exceeded',
    );
    assert.equal(result, '[both comparers: Maximum call stack size exceeded]');
  });

  it('returns bracket-tag format when only one comparer has stack overflow', () => {
    const result = classifyHydrationFailTag('Maximum call stack size exceeded', null);
    assert.ok(result.includes('[smartCompare: Maximum call stack size exceeded]'));
  });

  it('is case-insensitive for stack overflow detection', () => {
    const result = classifyHydrationFailTag(
      'maximum call stack size exceeded',
      'maximum call stack size exceeded',
    );
    assert.ok(result.includes('call stack'));
  });
});

describe('classifyHydrationFailTag — identity/reference mismatch', () => {
  it('returns clean phrase for "Cycle structure mismatch" errors', () => {
    const result = classifyHydrationFailTag(
      'Cycle structure mismatch: expected node "comp_0" is paired with more than one actual',
      'Dependency of node "comp_1" at index 1 is not present in the top-level actual array',
    );
    assert.equal(result, '— shared references were duplicated');
  });

  it('returns clean phrase when smartErr contains "is paired with more than one"', () => {
    const result = classifyHydrationFailTag(
      'is paired with more than one actual node',
      null,
    );
    assert.equal(result, '— shared references were duplicated');
  });

  it('returns clean phrase when flatErr mentions "not present in the top-level"', () => {
    const result = classifyHydrationFailTag(
      null,
      'not present in the top-level actual array',
    );
    assert.equal(result, '— shared references were duplicated');
  });
});

describe('classifyHydrationFailTag — other / fallback', () => {
  it('falls back to bracket-tag for unrecognised error types', () => {
    const result = classifyHydrationFailTag('id mismatch at index 3', 'id mismatch at index 3');
    assert.equal(result, '[both comparers: id mismatch at index 3]');
  });

  it('returns bracket-tag with both comparer details when errors differ', () => {
    const result = classifyHydrationFailTag('dependencies length mismatch', 'wrong dep target');
    assert.ok(result.includes('[smartCompare: dependencies length mismatch]'));
    assert.ok(result.includes('[flatCompare: wrong dep target]'));
  });
});

// ---------------------------------------------------------------------------
// buildDetailHydrationLine — full-detail Hydration: line
// ---------------------------------------------------------------------------

describe('buildDetailHydrationLine — pass', () => {
  it('returns the "✅ PASS (double-verified)" hydration line', () => {
    const line = buildDetailHydrationLine(true, false, '✅ PASS (double-verified)');
    assert.equal(line, '  Hydration:     ✅ PASS (double-verified)');
  });
});

describe('buildDetailHydrationLine — fail', () => {
  it('returns hydration fail line with stack overflow tag', () => {
    const line = buildDetailHydrationLine(
      false,
      false,
      '❌ FAIL [both comparers: Maximum call stack size exceeded]',
    );
    assert.equal(
      line,
      '  Hydration:     ❌ FAIL [both comparers: Maximum call stack size exceeded]',
    );
  });

  it('returns hydration fail line with clean identity mismatch phrase', () => {
    const line = buildDetailHydrationLine(
      false,
      false,
      '❌ FAIL — shared references were duplicated',
    );
    assert.equal(line, '  Hydration:     ❌ FAIL — shared references were duplicated');
  });
});

describe('buildDetailHydrationLine — conflict', () => {
  it('always shows the conflict label regardless of resultLine', () => {
    const line = buildDetailHydrationLine(false, true, '🚨 CONFLICT — smartCompare=FAIL, flatCompare=PASS');
    assert.equal(line, '  Hydration:     🚨 CONFLICT — comparers disagree');
  });
});

// ---------------------------------------------------------------------------
// buildDetailConsumerProbesLine — full-detail Consumer probes: line
// ---------------------------------------------------------------------------

describe('buildDetailConsumerProbesLine — probes ran', () => {
  it('returns probe summary string when probes ran (both pass)', () => {
    const line = buildDetailConsumerProbesLine(true, '✅ naive-json  ✅ cycle-flat (output ✅)');
    assert.equal(line, '  Consumer probes: ✅ naive-json  ✅ cycle-flat (output ✅)');
  });

  it('returns probe summary string when probes ran (naive fails, cycle passes)', () => {
    const line = buildDetailConsumerProbesLine(true, '❌ naive-json  ✅ cycle-flat (output ✅)');
    assert.equal(line, '  Consumer probes: ❌ naive-json  ✅ cycle-flat (output ✅)');
  });
});

describe('buildDetailConsumerProbesLine — not run (hydration failed)', () => {
  it('returns "not run (hydration failed)" when probes did not run', () => {
    const line = buildDetailConsumerProbesLine(false, '');
    assert.equal(line, '  Consumer probes: not run (hydration failed)');
  });

  it('returns "not run (hydration failed)" when disagree=false and no probes', () => {
    const line = buildDetailConsumerProbesLine(false, '', false);
    assert.equal(line, '  Consumer probes: not run (hydration failed)');
  });
});

describe('buildDetailConsumerProbesLine — not run (conflict)', () => {
  it('returns "not run (comparers conflicted)" when disagree=true', () => {
    const line = buildDetailConsumerProbesLine(false, '', true);
    assert.equal(line, '  Consumer probes: not run (comparers conflicted)');
  });
});

// ---------------------------------------------------------------------------
// buildDetailFullRunLine — full-detail Full Run: line
// ---------------------------------------------------------------------------

describe('buildDetailFullRunLine — full pass', () => {
  it('returns PASS line with Time and RAM when endToEndPass=true', () => {
    const line = buildDetailFullRunLine(true, true, false, 1.8, 0.05);
    assert.ok(line.startsWith('  Full Run:      ✅ PASS'));
    assert.ok(line.includes('Time:'));
    assert.ok(line.includes('RAM:'));
  });

  it('does not include "(double-verified)" on the Full Run line (only on Hydration line)', () => {
    const line = buildDetailFullRunLine(true, true, false, 1.8, 0.05);
    assert.ok(!line.includes('double-verified'));
  });
});

describe('buildDetailFullRunLine — hydration failed', () => {
  it('returns "not run (hydration failed)" when bothPass=false and no conflict', () => {
    const line = buildDetailFullRunLine(false, false, false, 0, 0);
    assert.equal(line, '  Full Run:      not run (hydration failed)');
  });
});

describe('buildDetailFullRunLine — conflict', () => {
  it('returns "🚨 CONFLICT" when disagree=true', () => {
    const line = buildDetailFullRunLine(false, false, true, 0, 0);
    assert.equal(line, '  Full Run:      🚨 CONFLICT');
  });
});

describe('buildDetailFullRunLine — hydration pass, probe fail', () => {
  it('returns "❌ FAIL" when hydration passed but endToEndPass=false', () => {
    const line = buildDetailFullRunLine(false, true, false, 0, 0);
    assert.equal(line, '  Full Run:      ❌ FAIL');
  });
});

// ---------------------------------------------------------------------------
// Full output-format contract matrix (three-line phase contract)
// ---------------------------------------------------------------------------

describe('full-detail three-line phase contract — hydration fail scenario', () => {
  it('produces Hydration FAIL → Consumer probes not run → Full Run not run', () => {
    const resultLine = '❌ FAIL [both comparers: Maximum call stack size exceeded]';
    const hydrationLine = buildDetailHydrationLine(false, false, resultLine);
    const probesLine = buildDetailConsumerProbesLine(false, '');
    const fullRunLine = buildDetailFullRunLine(false, false, false, 0, 0);

    assert.equal(hydrationLine, `  Hydration:     ${resultLine}`);
    assert.equal(probesLine, '  Consumer probes: not run (hydration failed)');
    assert.equal(fullRunLine, '  Full Run:      not run (hydration failed)');
  });

  it('line order matches: Hydration → Consumer probes → Full Run', () => {
    const lines = [
      buildDetailHydrationLine(false, false, '❌ FAIL [both comparers: stack]'),
      buildDetailConsumerProbesLine(false, ''),
      buildDetailFullRunLine(false, false, false, 0, 0),
    ];
    assert.ok(lines[0].startsWith('  Hydration:'));
    assert.ok(lines[1].startsWith('  Consumer probes:'));
    assert.ok(lines[2].startsWith('  Full Run:'));
  });
});

describe('full-detail three-line phase contract — full pass scenario', () => {
  it('produces Hydration PASS → Consumer probes → Full Run PASS with metrics', () => {
    const resultLine = '✅ PASS (double-verified)';
    const probeSummary = '✅ naive-json  ✅ cycle-flat (output ✅)';
    const hydrationLine = buildDetailHydrationLine(true, false, resultLine);
    const probesLine = buildDetailConsumerProbesLine(true, probeSummary);
    const fullRunLine = buildDetailFullRunLine(true, true, false, 2.5, 0.1);

    assert.equal(hydrationLine, '  Hydration:     ✅ PASS (double-verified)');
    assert.equal(probesLine, '  Consumer probes: ✅ naive-json  ✅ cycle-flat (output ✅)');
    assert.ok(fullRunLine.startsWith('  Full Run:      ✅ PASS'));
    assert.ok(fullRunLine.includes('Time:'));
    assert.ok(fullRunLine.includes('RAM:'));
  });
});

describe('full-detail three-line phase contract — hydration pass, probe fail scenario', () => {
  it('produces Hydration PASS → Consumer probes FAIL → Full Run FAIL', () => {
    const resultLine = '✅ PASS (double-verified)';
    const probeSummary = '❌ naive-json  ❌ cycle-flat';
    const hydrationLine = buildDetailHydrationLine(true, false, resultLine);
    const probesLine = buildDetailConsumerProbesLine(true, probeSummary);
    const fullRunLine = buildDetailFullRunLine(false, true, false, 0, 0);

    assert.equal(hydrationLine, '  Hydration:     ✅ PASS (double-verified)');
    assert.ok(probesLine.includes('❌ naive-json'));
    assert.equal(fullRunLine, '  Full Run:      ❌ FAIL');
  });
});

describe('full-detail three-line phase contract — conflict scenario', () => {
  it('produces Hydration CONFLICT → Consumer probes conflicted → Full Run CONFLICT', () => {
    const hydrationLine = buildDetailHydrationLine(false, true, '🚨 any');
    const probesLine = buildDetailConsumerProbesLine(false, '', true);
    const fullRunLine = buildDetailFullRunLine(false, false, true, 0, 0);

    assert.equal(hydrationLine, '  Hydration:     🚨 CONFLICT — comparers disagree');
    assert.equal(probesLine, '  Consumer probes: not run (comparers conflicted)');
    assert.equal(fullRunLine, '  Full Run:      🚨 CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// Later-tier new failure — consumer probes line now required
// ---------------------------------------------------------------------------

describe('buildLaterDatasetLines — new failure always includes consumer probes line', () => {
  it('adds "not run (hydration failed)" when probeChangeLine is null for a new failure', () => {
    const outcome: LaterAlgoOutcome = makeNewFailOutcome('Map Tracker', 'Reference Tracking');
    // Confirm probeChangeLine is null in the default helper
    assert.equal(outcome.probeChangeLine, null);

    const lines = buildLaterDatasetLines([outcome]);
    assert.ok(lines.some((l) => l.includes('Consumer probes: not run (hydration failed)')));
  });

  it('uses probeChangeLine when it is non-null (overrides the default "not run" line)', () => {
    const outcome: LaterAlgoOutcome = {
      ...makeNewFailOutcome('Map Tracker', 'Reference Tracking'),
      probeChangeLine: '  Consumer probes: ⚠️  changed from baseline — ❌ naive-json',
    };
    const lines = buildLaterDatasetLines([outcome]);
    // The explicit probeChangeLine takes precedence
    assert.ok(lines.some((l) => l.includes('Consumer probes: ⚠️  changed from baseline')));
    // The default "not run" line should NOT appear since probeChangeLine was provided
    assert.ok(!lines.some((l) => l.includes('not run (hydration failed)')));
  });
});

// ---------------------------------------------------------------------------
// acyclic-control — format contract: Naive Recursion passes
// ---------------------------------------------------------------------------

describe('buildDetailHydrationLine — acyclic-control Naive Recursion pass', () => {
  it('renders the pass line correctly for Naive Recursion on the isolated-node acyclic-control dataset', () => {
    // Naive Recursion succeeds on the isolated-node acyclic-control dataset
    // because no node is both a top-level entry and a dependency of another node.
    const line = buildDetailHydrationLine(true, false, '✅ PASS (double-verified)');
    assert.equal(line, '  Hydration:     ✅ PASS (double-verified)');
  });
});

// ---------------------------------------------------------------------------
// buildLaterDatasetLines — later-tier hydration-fail shows consumer probes line
// ---------------------------------------------------------------------------

describe('buildLaterDatasetLines — new failure consumer probes explicitness', () => {
  it('stress-tier Map Tracker failure shows both Hydration and Consumer probes lines', () => {
    // Simulates: Map Tracker passed at basic but newly fails at stress.
    const outcomes: LaterAlgoOutcome[] = [
      makeSkippedOutcome('Naive Recursion', 'Reference Tracking'),
      makeNewFailOutcome('Map Tracker', 'Reference Tracking'),
      makePassOutcome('Tarjan SCC Layering', 'Topological'),
      makePassOutcome('Two-Pass Wire', 'Schema-Driven'),
    ];
    const lines = buildLaterDatasetLines(outcomes);

    // Both phase lines must appear for the new failure
    const hasHydrationFail = lines.some((l) => l.includes('Hydration:') && l.includes('❌ FAIL'));
    const hasProbesNotRun = lines.some((l) => l.includes('Consumer probes: not run (hydration failed)'));
    assert.ok(hasHydrationFail, 'Should have Hydration: ❌ FAIL line');
    assert.ok(hasProbesNotRun, 'Should have Consumer probes: not run line');
  });
});

// ---------------------------------------------------------------------------
// normalizeFullDetailPhaseState — normalization layer
// ---------------------------------------------------------------------------

describe('normalizeFullDetailPhaseState — hydration fail', () => {
  it('returns state with hydrationPassed=false and endToEndPass=false', () => {
    const state = normalizeFullDetailPhaseState(
      false, false, false, false,
      '❌ FAIL [both comparers: Maximum call stack size exceeded]', '',
      0, 0,
    );
    assert.equal(state.hydrationPassed, false);
    assert.equal(state.comparersConflict, false);
    assert.equal(state.endToEndPass, false);
    assert.equal(state.probesRan, false);
    assert.equal(state.hydrationResultText, '❌ FAIL [both comparers: Maximum call stack size exceeded]');
  });
});

describe('normalizeFullDetailPhaseState — conflict', () => {
  it('returns state with comparersConflict=true', () => {
    const state = normalizeFullDetailPhaseState(
      false, true, false, false,
      '🚨 CONFLICT — comparers disagree', '',
      0, 0,
    );
    assert.equal(state.comparersConflict, true);
    assert.equal(state.hydrationPassed, false);
    assert.equal(state.endToEndPass, false);
  });
});

describe('normalizeFullDetailPhaseState — full pass', () => {
  it('returns state with hydrationPassed=true and endToEndPass=true', () => {
    const state = normalizeFullDetailPhaseState(
      true, false, true, true,
      '✅ PASS (double-verified)', '✅ naive-json  ✅ cycle-flat (output ✅)',
      2.5, 0.1,
    );
    assert.equal(state.hydrationPassed, true);
    assert.equal(state.endToEndPass, true);
    assert.equal(state.probesRan, true);
    assert.equal(state.probeSummaryText, '✅ naive-json  ✅ cycle-flat (output ✅)');
    assert.equal(state.headlineTimeMs, 2.5);
    assert.equal(state.headlineRamMb, 0.1);
  });
});

describe('normalizeFullDetailPhaseState — hydration pass, cycle-flat fail', () => {
  it('returns state with hydrationPassed=true but endToEndPass=false', () => {
    const state = normalizeFullDetailPhaseState(
      true, false, false, true,
      '✅ PASS (double-verified)', '✅ naive-json  ❌ cycle-flat',
      0, 0,
    );
    assert.equal(state.hydrationPassed, true);
    assert.equal(state.endToEndPass, false);
    assert.equal(state.probesRan, true);
  });
});

// ---------------------------------------------------------------------------
// normalizeFullDetailPhaseState — invariant clamping
//
// Verifies that the normalization step enforces structural consistency even
// when callers pass logically contradictory flag combinations.
// ---------------------------------------------------------------------------

describe('normalizeFullDetailPhaseState — clamping: conflict forces hydration/probes/endToEnd false', () => {
  it('clamps hydrationPassed=false when comparersConflict=true, even if caller passes true', () => {
    const state = normalizeFullDetailPhaseState(
      true /* hydrationPassed */, true /* comparersConflict */, true /* endToEndPass */, true /* probesRan */,
      '🚨 CONFLICT', '', 5, 0.1,
    );
    // A conflict means neither comparer agreed — hydration cannot be "passed"
    assert.equal(state.hydrationPassed, false, 'hydrationPassed must be false when comparers conflict');
    assert.equal(state.probesRan, false, 'probesRan must be false when comparers conflict');
    assert.equal(state.endToEndPass, false, 'endToEndPass must be false when comparers conflict');
    // comparersConflict itself is preserved as-is (it's the root flag)
    assert.equal(state.comparersConflict, true);
  });

  it('renders correct conflict output even when contradictory inputs are given', () => {
    const state = normalizeFullDetailPhaseState(
      true, true, true, true, '🚨 CONFLICT', '✅ naive-json', 5, 0.1,
    );
    const [h, p, f] = renderFullDetailLines(state);
    assert.equal(h, '  Hydration:     🚨 CONFLICT — comparers disagree');
    assert.equal(p, '  Consumer probes: not run (comparers conflicted)');
    assert.equal(f, '  Full Run:      🚨 CONFLICT');
    // No metrics should appear on any line
    assert.ok(!f.includes('Time:'), 'Conflict must not show metrics');
    assert.ok(!h.includes('✅'), 'Conflict Hydration line must not show ✅');
  });
});

describe('normalizeFullDetailPhaseState — clamping: no probes when hydration failed', () => {
  it('clamps probesRan=false when hydrationPassed=false, even if caller passes true', () => {
    const state = normalizeFullDetailPhaseState(
      false /* hydrationPassed */, false /* conflict */, false, true /* probesRan: contradictory */,
      '❌ FAIL [both comparers: stack]', '✅ naive-json', 0, 0,
    );
    assert.equal(state.hydrationPassed, false);
    assert.equal(state.probesRan, false, 'probesRan must be clamped to false when hydration failed');
    assert.equal(state.endToEndPass, false);
  });

  it('renders correct hydration-fail output even when contradictory probesRan=true is given', () => {
    const state = normalizeFullDetailPhaseState(
      false, false, false, true /* contradictory */, '❌ FAIL [both comparers: stack]', '✅ naive-json', 0, 0,
    );
    const [_h, p, _f] = renderFullDetailLines(state);
    // Probes line must say "not run" — the clamped probesRan=false controls the output
    assert.equal(p, '  Consumer probes: not run (hydration failed)');
    assert.ok(!p.includes('✅ naive-json'), 'Probe summary must not appear when hydration failed');
  });
});

describe('normalizeFullDetailPhaseState — clamping: no endToEnd when probes did not run', () => {
  it('clamps endToEndPass=false when probesRan=false, even if caller passes true', () => {
    const state = normalizeFullDetailPhaseState(
      true /* hydrationPassed */, false, true /* endToEndPass: contradictory */, false /* probesRan */,
      '✅ PASS (double-verified)', '', 5, 0.1,
    );
    assert.equal(state.hydrationPassed, true);
    assert.equal(state.probesRan, false);
    // endToEndPass requires probes to have run — must be false
    assert.equal(state.endToEndPass, false, 'endToEndPass must be clamped to false when probes did not run');
  });
});

// ---------------------------------------------------------------------------
// renderFullDetailLines — three-line phase contract render wrapper
// ---------------------------------------------------------------------------

describe('renderFullDetailLines — returns exactly three strings', () => {
  it('always returns a tuple of exactly three strings', () => {
    const state = normalizeFullDetailPhaseState(
      false, false, false, false,
      '❌ FAIL [both comparers: stack]', '',
      0, 0,
    );
    const lines = renderFullDetailLines(state);
    assert.equal(lines.length, 3);
    assert.equal(typeof lines[0], 'string');
    assert.equal(typeof lines[1], 'string');
    assert.equal(typeof lines[2], 'string');
  });

  it('line 0 always starts with "  Hydration:"', () => {
    for (const state of [
      normalizeFullDetailPhaseState(false, false, false, false, '❌ FAIL [x]', '', 0, 0),
      normalizeFullDetailPhaseState(true, false, true, true, '✅ PASS (double-verified)', '✅ naive-json', 1, 0.1),
      normalizeFullDetailPhaseState(false, true, false, false, '🚨 any', '', 0, 0),
    ]) {
      const lines = renderFullDetailLines(state);
      assert.ok(lines[0].startsWith('  Hydration:'), `Expected "  Hydration:" prefix, got: ${lines[0]}`);
    }
  });

  it('line 1 always starts with "  Consumer probes:"', () => {
    for (const state of [
      normalizeFullDetailPhaseState(false, false, false, false, '❌ FAIL [x]', '', 0, 0),
      normalizeFullDetailPhaseState(true, false, true, true, '✅ PASS (double-verified)', '✅ naive-json', 1, 0.1),
      normalizeFullDetailPhaseState(false, true, false, false, '🚨 any', '', 0, 0),
    ]) {
      const lines = renderFullDetailLines(state);
      assert.ok(lines[1].startsWith('  Consumer probes:'), `Expected "  Consumer probes:" prefix, got: ${lines[1]}`);
    }
  });

  it('line 2 always starts with "  Full Run:"', () => {
    for (const state of [
      normalizeFullDetailPhaseState(false, false, false, false, '❌ FAIL [x]', '', 0, 0),
      normalizeFullDetailPhaseState(true, false, true, true, '✅ PASS (double-verified)', '✅ naive-json', 1, 0.1),
      normalizeFullDetailPhaseState(false, true, false, false, '🚨 any', '', 0, 0),
    ]) {
      const lines = renderFullDetailLines(state);
      assert.ok(lines[2].startsWith('  Full Run:'), `Expected "  Full Run:" prefix, got: ${lines[2]}`);
    }
  });
});

describe('renderFullDetailLines — hydration fail state', () => {
  it('produces expected three lines for hydration fail (stack overflow)', () => {
    const state = normalizeFullDetailPhaseState(
      false, false, false, false,
      '❌ FAIL [both comparers: Maximum call stack size exceeded]', '',
      0, 0,
    );
    const [h, p, f] = renderFullDetailLines(state);
    assert.equal(h, '  Hydration:     ❌ FAIL [both comparers: Maximum call stack size exceeded]');
    assert.equal(p, '  Consumer probes: not run (hydration failed)');
    assert.equal(f, '  Full Run:      not run (hydration failed)');
  });
});

describe('renderFullDetailLines — conflict state', () => {
  it('produces expected three lines for comparer conflict', () => {
    const state = normalizeFullDetailPhaseState(
      false, true, false, false,
      '🚨 CONFLICT — comparers disagree', '',
      0, 0,
    );
    const [h, p, f] = renderFullDetailLines(state);
    assert.equal(h, '  Hydration:     🚨 CONFLICT — comparers disagree');
    assert.equal(p, '  Consumer probes: not run (comparers conflicted)');
    assert.equal(f, '  Full Run:      🚨 CONFLICT');
  });
});

describe('renderFullDetailLines — full pass state', () => {
  it('produces expected three lines for full pass (both probes pass)', () => {
    const state = normalizeFullDetailPhaseState(
      true, false, true, true,
      '✅ PASS (double-verified)', '✅ naive-json  ✅ cycle-flat (output ✅)',
      2.5, 0.1,
    );
    const [h, p, f] = renderFullDetailLines(state);
    assert.equal(h, '  Hydration:     ✅ PASS (double-verified)');
    assert.equal(p, '  Consumer probes: ✅ naive-json  ✅ cycle-flat (output ✅)');
    assert.ok(f.startsWith('  Full Run:      ✅ PASS'));
    assert.ok(f.includes('Time:'));
    assert.ok(f.includes('RAM:'));
  });
});

// ---------------------------------------------------------------------------
// Full state matrix — missing cases from the full probe outcome space
// ---------------------------------------------------------------------------

describe('full-detail three-line phase contract — hydration pass + naive-json fail + cycle-flat pass', () => {
  it('produces Full Run PASS even though naive-json failed (cycle-flat is authoritative)', () => {
    // This is the core semantic: naive-json failure on cyclic graphs is expected
    // and informational. cycle-flat passing means the experiment is a Full Run pass.
    const resultLine = '✅ PASS (double-verified)';
    const probeSummary = '❌ naive-json  ✅ cycle-flat (output ✅)';
    const hydrationLine = buildDetailHydrationLine(true, false, resultLine);
    const probesLine = buildDetailConsumerProbesLine(true, probeSummary);
    // endToEndPass=true because cycle-flat passed (the authoritative probe).
    const fullRunLine = buildDetailFullRunLine(true, true, false, 3.0, 0.2);

    assert.equal(hydrationLine, '  Hydration:     ✅ PASS (double-verified)');
    assert.ok(probesLine.includes('❌ naive-json'), 'naive-json failure must be visible in probe summary');
    assert.ok(probesLine.includes('✅ cycle-flat'), 'cycle-flat pass must be visible in probe summary');
    assert.ok(fullRunLine.startsWith('  Full Run:      ✅ PASS'), 'Full Run must be PASS when cycle-flat passes');
    assert.ok(fullRunLine.includes('Time:'), 'Full Run PASS must include timing');
    assert.ok(fullRunLine.includes('RAM:'), 'Full Run PASS must include RAM');
  });

  it('renderFullDetailLines produces the same result via state object', () => {
    const state = normalizeFullDetailPhaseState(
      true, false, true /* endToEndPass: cycle-flat passed */, true,
      '✅ PASS (double-verified)', '❌ naive-json  ✅ cycle-flat (output ✅)',
      3.0, 0.2,
    );
    const [h, p, f] = renderFullDetailLines(state);
    assert.equal(h, '  Hydration:     ✅ PASS (double-verified)');
    assert.ok(p.includes('❌ naive-json'));
    assert.ok(p.includes('✅ cycle-flat'));
    assert.ok(f.startsWith('  Full Run:      ✅ PASS'));
  });
});

describe('full-detail three-line phase contract — hydration pass + naive-json pass + cycle-flat fail', () => {
  it('produces Full Run FAIL when cycle-flat fails (authoritative probe failure)', () => {
    // This is a rare but important case: naive-json passes but cycle-flat fails.
    // Since cycle-flat is the authoritative probe, the full run fails.
    const resultLine = '✅ PASS (double-verified)';
    const probeSummary = '✅ naive-json  ❌ cycle-flat';
    const hydrationLine = buildDetailHydrationLine(true, false, resultLine);
    const probesLine = buildDetailConsumerProbesLine(true, probeSummary);
    // endToEndPass=false because cycle-flat failed.
    const fullRunLine = buildDetailFullRunLine(false, true, false, 0, 0);

    assert.equal(hydrationLine, '  Hydration:     ✅ PASS (double-verified)');
    assert.ok(probesLine.includes('✅ naive-json'));
    assert.ok(probesLine.includes('❌ cycle-flat'));
    assert.equal(fullRunLine, '  Full Run:      ❌ FAIL');
  });

  it('renderFullDetailLines produces the same result via state object', () => {
    const state = normalizeFullDetailPhaseState(
      true, false, false /* endToEndPass: cycle-flat failed */, true,
      '✅ PASS (double-verified)', '✅ naive-json  ❌ cycle-flat',
      0, 0,
    );
    const [h, p, f] = renderFullDetailLines(state);
    assert.equal(h, '  Hydration:     ✅ PASS (double-verified)');
    assert.ok(p.includes('✅ naive-json'));
    assert.ok(p.includes('❌ cycle-flat'));
    assert.equal(f, '  Full Run:      ❌ FAIL');
  });
});

// ---------------------------------------------------------------------------
// State matrix validity — no contradictory text across the three lines
// ---------------------------------------------------------------------------

describe('full-detail state matrix validity — no contradictory text', () => {
  /**
   * Tests that for every valid input state, the three-line output does not
   * contain internally contradictory content (e.g. a line saying "not run"
   * while another line shows metrics, or a ✅ on a line that also shows ❌).
   */

  it('hydration fail: no ✅ on any line, no metrics, no "probes ran" content', () => {
    const state = normalizeFullDetailPhaseState(
      false, false, false, false,
      '❌ FAIL [both comparers: Maximum call stack size exceeded]', '',
      0, 0,
    );
    const [h, p, f] = renderFullDetailLines(state);
    // No pass indicators on any line
    assert.ok(!h.includes('✅'), `Hydration line must not show ✅ on fail: ${h}`);
    assert.ok(!p.includes('✅'), `Probes line must not show ✅ on hydration fail: ${p}`);
    assert.ok(!f.includes('✅'), `Full Run line must not show ✅ on hydration fail: ${f}`);
    // No metrics on fail
    assert.ok(!f.includes('Time:'), 'Full Run line must not show metrics when hydration failed');
    assert.ok(!f.includes('RAM:'), 'Full Run line must not show RAM when hydration failed');
    // Probes line says "not run"
    assert.ok(p.includes('not run (hydration failed)'));
    // Full Run line says "not run"
    assert.ok(f.includes('not run (hydration failed)'));
  });

  it('conflict: no pass/fail status indicators, no metrics, consistent CONFLICT across all lines', () => {
    const state = normalizeFullDetailPhaseState(
      false, true, false, false,
      '🚨 CONFLICT — comparers disagree', '',
      0, 0,
    );
    const [h, p, f] = renderFullDetailLines(state);
    assert.ok(h.includes('🚨 CONFLICT'), 'Hydration line must show CONFLICT');
    assert.ok(p.includes('comparers conflicted'), 'Probes line must reference conflict reason');
    assert.ok(f.includes('🚨 CONFLICT'), 'Full Run line must show CONFLICT');
    assert.ok(!f.includes('Time:'), 'No metrics on conflict');
    assert.ok(!h.includes('✅'), 'No pass indicator on conflict hydration line');
  });

  it('full pass: ✅ on all lines, metrics only on Full Run, no ❌ or "not run"', () => {
    const state = normalizeFullDetailPhaseState(
      true, false, true, true,
      '✅ PASS (double-verified)', '✅ naive-json  ✅ cycle-flat (output ✅)',
      2.5, 0.1,
    );
    const [h, p, f] = renderFullDetailLines(state);
    assert.ok(h.includes('✅'), 'Hydration line must show ✅ on pass');
    assert.ok(p.includes('✅'), 'Probes line must show ✅ on pass');
    assert.ok(f.includes('✅ PASS'), 'Full Run line must show ✅ PASS');
    assert.ok(f.includes('Time:'), 'Full Run line must include timing on pass');
    assert.ok(f.includes('RAM:'), 'Full Run line must include RAM on pass');
    assert.ok(!h.includes('not run'), 'Hydration line must not say "not run" on pass');
    assert.ok(!p.includes('not run'), 'Probes line must not say "not run" on pass');
    assert.ok(!f.includes('not run'), 'Full Run line must not say "not run" on pass');
  });

  it('hydration pass + cycle-flat fail: Hydration ✅, Probes shows ❌ cycle-flat, Full Run ❌ FAIL (no metrics)', () => {
    const state = normalizeFullDetailPhaseState(
      true, false, false, true,
      '✅ PASS (double-verified)', '✅ naive-json  ❌ cycle-flat',
      0, 0,
    );
    const [h, p, f] = renderFullDetailLines(state);
    assert.ok(h.includes('✅ PASS'), 'Hydration must show pass');
    assert.ok(p.includes('❌ cycle-flat'), 'Probes must show cycle-flat failure');
    assert.equal(f, '  Full Run:      ❌ FAIL', 'Full Run must be ❌ FAIL');
    assert.ok(!f.includes('Time:'), 'No metrics when cycle-flat failed');
    assert.ok(!f.includes('RAM:'), 'No RAM when cycle-flat failed');
    assert.ok(!f.includes('not run'), 'Full Run line must not say "not run" when hydration passed');
  });

  it('hydration pass + naive-json fail + cycle-flat pass: Full Run is ✅ PASS with metrics', () => {
    // naive-json failure must not prevent Full Run from passing.
    const state = normalizeFullDetailPhaseState(
      true, false, true, true,
      '✅ PASS (double-verified)', '❌ naive-json  ✅ cycle-flat (output ✅)',
      3.0, 0.2,
    );
    const [h, p, f] = renderFullDetailLines(state);
    assert.ok(h.includes('✅ PASS'), 'Hydration must show pass');
    assert.ok(p.includes('❌ naive-json'), 'naive-json failure must be visible');
    assert.ok(p.includes('✅ cycle-flat'), 'cycle-flat pass must be visible');
    assert.ok(f.startsWith('  Full Run:      ✅ PASS'), 'Full Run must be ✅ PASS when cycle-flat passes');
    assert.ok(f.includes('Time:'), 'Full Run PASS must include metrics');
  });
});

// ---------------------------------------------------------------------------
// Dataset output format matrix — audit log generator
//
// Generates logs/dataset-output-format-matrix.log covering every possible
// display state for the full-detail three-line phase contract and the
// later-tier compact format.  The file is intended for manual human review
// of formatting consistency; it is gitignored and uploaded as a CI artifact.
// ---------------------------------------------------------------------------

describe('dataset-output-format-matrix — generate audit log', () => {
  it('writes logs/dataset-output-format-matrix.log with all display states', () => {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const lines: string[] = [];

    const line = (s = '') => lines.push(s);

    line('=== Dataset Output Format Matrix ===');
    line(`Generated by: npm test (src/runner.test.ts)`);
    line(`Purpose: Canonical audit of all possible display states for dataset run results.`);
    line(`         Review this file to check formatting consistency across all states.`);
    line();

    // ── Section 1: Full-detail three-line phase contract ──────────────────

    line('─────────────────────────────────────────────────────────────────────');
    line('Section 1: Full-detail three-line phase contract');
    line('Datasets: acyclic-control and basic (first two tiers).');
    line('Each case shows: Hydration: / Consumer probes: / Full Run:');
    line('─────────────────────────────────────────────────────────────────────');
    line();

    // Case 1: Hydration fail — stack overflow
    line('[Case 1] Hydration fail — stack overflow (both comparers)');
    {
      const state = normalizeFullDetailPhaseState(
        false, false, false, false,
        '❌ FAIL [both comparers: Maximum call stack size exceeded]', '',
        0, 0,
      );
      for (const l of renderFullDetailLines(state)) line(l);
    }
    line();

    // Case 2: Hydration fail — shared-reference mismatch (clean phrase)
    line('[Case 2] Hydration fail — shared-reference mismatch (clean classification)');
    {
      const state = normalizeFullDetailPhaseState(
        false, false, false, false,
        '❌ FAIL — shared references were duplicated', '',
        0, 0,
      );
      for (const l of renderFullDetailLines(state)) line(l);
    }
    line();

    // Case 3: Hydration fail — fallback / other (one comparer each)
    line('[Case 3] Hydration fail — fallback: two distinct comparer errors');
    {
      const state = normalizeFullDetailPhaseState(
        false, false, false, false,
        '❌ FAIL [smartCompare: dep target mismatch] [flatCompare: length wrong]', '',
        0, 0,
      );
      for (const l of renderFullDetailLines(state)) line(l);
    }
    line();

    // Case 4: Comparer conflict
    line('[Case 4] Comparer conflict — comparers disagree');
    {
      const state = normalizeFullDetailPhaseState(
        false, true, false, false,
        '🚨 CONFLICT — comparers disagree', '',
        0, 0,
      );
      for (const l of renderFullDetailLines(state)) line(l);
    }
    line();

    // Case 5: Full pass — both probes pass
    line('[Case 5] Full pass — hydration ✅, naive-json ✅, cycle-flat ✅');
    {
      const state = normalizeFullDetailPhaseState(
        true, false, true, true,
        '✅ PASS (double-verified)', '✅ naive-json  ✅ cycle-flat (output ✅)',
        2.5, 0.1,
      );
      for (const l of renderFullDetailLines(state)) line(l);
    }
    line();

    // Case 6: Hydration pass + naive-json fail + cycle-flat pass (expected cyclic failure)
    line('[Case 6] Hydration pass + naive-json ❌ + cycle-flat ✅ (expected cyclic failure)');
    line('         naive-json failure is informational; cycle-flat is authoritative → Full Run PASS');
    {
      const state = normalizeFullDetailPhaseState(
        true, false, true, true,
        '✅ PASS (double-verified)', '❌ naive-json  ✅ cycle-flat (output ✅)',
        2.5, 0.1,
      );
      for (const l of renderFullDetailLines(state)) line(l);
    }
    line();

    // Case 7: Hydration pass + naive-json pass + cycle-flat fail
    line('[Case 7] Hydration pass + naive-json ✅ + cycle-flat ❌ (authoritative probe failure)');
    line('         cycle-flat fails → Full Run FAIL (despite naive-json passing)');
    {
      const state = normalizeFullDetailPhaseState(
        true, false, false, true,
        '✅ PASS (double-verified)', '✅ naive-json  ❌ cycle-flat',
        0, 0,
      );
      for (const l of renderFullDetailLines(state)) line(l);
    }
    line();

    // Case 8: Hydration pass + naive-json fail + cycle-flat fail
    line('[Case 8] Hydration pass + naive-json ❌ + cycle-flat ❌ (both probes fail)');
    {
      const state = normalizeFullDetailPhaseState(
        true, false, false, true,
        '✅ PASS (double-verified)', '❌ naive-json  ❌ cycle-flat',
        0, 0,
      );
      for (const l of renderFullDetailLines(state)) line(l);
    }
    line();

    // ── Section 2: Later-tier compact format ──────────────────────────────

    line('─────────────────────────────────────────────────────────────────────');
    line('Section 2: Later-tier compact format');
    line('Datasets: medium, stress, extreme (after the cyclic baseline).');
    line('Output is deferred and batch-formatted by buildLaterDatasetLines.');
    line('─────────────────────────────────────────────────────────────────────');
    line();

    function passHydLine(timeMs: number, ramMb: number): string {
      return buildFullRunLine(true, true, '✅ PASS (double-verified)', timeMs, ramMb);
    }

    // Case 9: All pass, no omissions — compact stable summary
    line('[Case 9] All pass, no omissions — compact "experiment stable" summary');
    {
      const outcomes: LaterAlgoOutcome[] = [
        { algoName: 'Naive Recursion', algoCategory: 'Reference Tracking', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(1, 0.1), failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Map Tracker', algoCategory: 'Reference Tracking', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(2, 0.2), failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Tarjan SCC Layering', algoCategory: 'Topological', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(3, 0.3), failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Two-Pass Wire', algoCategory: 'Schema-Driven', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(4, 0.4), failureDetailLines: [], probeChangeLine: null },
      ];
      for (const l of buildLaterDatasetLines(outcomes)) line(l);
    }
    line();

    // Case 10: Stable passes with omissions — individual entries shown
    line('[Case 10] Stable passes with omissions — individual entries (Naive Recursion skipped)');
    {
      const outcomes: LaterAlgoOutcome[] = [
        { algoName: 'Naive Recursion', algoCategory: 'Reference Tracking', baselineSkipped: true, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: null, failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Map Tracker', algoCategory: 'Reference Tracking', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(22, 9.1), failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Tarjan SCC Layering', algoCategory: 'Topological', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(18, 8.5), failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Two-Pass Wire', algoCategory: 'Schema-Driven', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(20, 8.9), failureDetailLines: [], probeChangeLine: null },
      ];
      for (const l of buildLaterDatasetLines(outcomes)) line(l);
    }
    line();

    // Case 11: New failure (hydration fails for the first time)
    line('[Case 11] New failure — Map Tracker newly fails (hydration ❌ for first time)');
    {
      const outcomes: LaterAlgoOutcome[] = [
        { algoName: 'Naive Recursion', algoCategory: 'Reference Tracking', baselineSkipped: true, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: null, failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Map Tracker', algoCategory: 'Reference Tracking', baselineSkipped: false, knownPriorFailure: false, isNewFailure: true, isConflict: false, probesFailed: false, hydrationLine: '  Hydration:     ❌ FAIL [both comparers: Maximum call stack size exceeded]', failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Tarjan SCC Layering', algoCategory: 'Topological', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(18, 8.5), failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Two-Pass Wire', algoCategory: 'Schema-Driven', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(20, 8.9), failureDetailLines: [], probeChangeLine: null },
      ];
      for (const l of buildLaterDatasetLines(outcomes)) line(l);
    }
    line();

    // Case 12: Known prior failure omitted
    line('[Case 12] Known prior failure — Map Tracker already failed at earlier tier (omitted)');
    {
      const outcomes: LaterAlgoOutcome[] = [
        { algoName: 'Naive Recursion', algoCategory: 'Reference Tracking', baselineSkipped: true, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: null, failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Map Tracker', algoCategory: 'Reference Tracking', baselineSkipped: false, knownPriorFailure: true, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: '  Hydration:     ❌ FAIL [both comparers: Maximum call stack size exceeded]', failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Tarjan SCC Layering', algoCategory: 'Topological', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(18, 8.5), failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Two-Pass Wire', algoCategory: 'Schema-Driven', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(20, 8.9), failureDetailLines: [], probeChangeLine: null },
      ];
      for (const l of buildLaterDatasetLines(outcomes)) line(l);
    }
    line();

    // Case 13: Comparer conflict on later tier
    line('[Case 13] Conflict on later tier — Map Tracker comparers disagree (always surfaced)');
    {
      const outcomes: LaterAlgoOutcome[] = [
        { algoName: 'Naive Recursion', algoCategory: 'Reference Tracking', baselineSkipped: true, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: null, failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Map Tracker', algoCategory: 'Reference Tracking', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: true, probesFailed: false, hydrationLine: '  Full Run:      🚨 CONFLICT — smartCompare=PASS, flatCompare=FAIL', failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Tarjan SCC Layering', algoCategory: 'Topological', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(18, 8.5), failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Two-Pass Wire', algoCategory: 'Schema-Driven', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(20, 8.9), failureDetailLines: [], probeChangeLine: null },
      ];
      for (const l of buildLaterDatasetLines(outcomes)) line(l);
    }
    line();

    // Case 14: Hydration pass + authoritative probe (cycle-flat) fail — two-line format
    line('[Case 14] Hydration pass + cycle-flat ❌ (authoritative probe fail) — two-line phase format');
    line('         probesFailed=true triggers "Hydration: ✅ PASS" + probe detail (no Full Run metrics)');
    {
      const outcomes: LaterAlgoOutcome[] = [
        { algoName: 'Naive Recursion', algoCategory: 'Reference Tracking', baselineSkipped: true, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: null, failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Map Tracker', algoCategory: 'Reference Tracking', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: true, hydrationLine: passHydLine(22, 9.1), failureDetailLines: [], probeChangeLine: '  Consumer probes: ❌ FAIL — ✅ naive-json  ❌ cycle-flat' },
        { algoName: 'Tarjan SCC Layering', algoCategory: 'Topological', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(18, 8.5), failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Two-Pass Wire', algoCategory: 'Schema-Driven', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(20, 8.9), failureDetailLines: [], probeChangeLine: null },
      ];
      for (const l of buildLaterDatasetLines(outcomes)) line(l);
    }
    line();

    // Case 15: Probe fingerprint changed (all still pass) — change line
    line('[Case 15] Probe fingerprint changed from baseline but all probes pass — change warning');
    {
      const outcomes: LaterAlgoOutcome[] = [
        { algoName: 'Naive Recursion', algoCategory: 'Reference Tracking', baselineSkipped: true, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: null, failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Map Tracker', algoCategory: 'Reference Tracking', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(22, 9.1), failureDetailLines: [], probeChangeLine: '  Consumer probes: ⚠️  changed from baseline — ✅ naive-json  ✅ cycle-flat (output ✅)' },
        { algoName: 'Tarjan SCC Layering', algoCategory: 'Topological', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(18, 8.5), failureDetailLines: [], probeChangeLine: null },
        { algoName: 'Two-Pass Wire', algoCategory: 'Schema-Driven', baselineSkipped: false, knownPriorFailure: false, isNewFailure: false, isConflict: false, probesFailed: false, hydrationLine: passHydLine(20, 8.9), failureDetailLines: [], probeChangeLine: null },
      ];
      for (const l of buildLaterDatasetLines(outcomes)) line(l);
    }
    line();

    // ── Section 3: Hydration failure display styles ────────────────────────

    line('─────────────────────────────────────────────────────────────────────');
    line('Section 3: Hydration failure display styles (classifyHydrationFailTag)');
    line('Shows how different error types are formatted for the Hydration: line.');
    line('─────────────────────────────────────────────────────────────────────');
    line();

    line('[Style A] Stack overflow — both comparers same error (bracket-tag consolidated)');
    line(`  ❌ FAIL ${classifyHydrationFailTag('Maximum call stack size exceeded', 'Maximum call stack size exceeded')}`);
    line();

    line('[Style B] Stack overflow — only smartCompare (bracket-tag, single comparer)');
    line(`  ❌ FAIL ${classifyHydrationFailTag('Maximum call stack size exceeded', null)}`);
    line();

    line('[Style C] Shared-reference mismatch — clean developer-friendly phrase');
    line(`  ❌ FAIL ${classifyHydrationFailTag('Cycle structure mismatch: expected node "comp_0"', 'Dependency of node "comp_1" is not present in the top-level')}`);
    line();

    line('[Style D] Shared-reference mismatch — "is paired with more than one" trigger');
    line(`  ❌ FAIL ${classifyHydrationFailTag('is paired with more than one actual node', null)}`);
    line();

    line('[Style E] Fallback — both comparers same unrecognised error (consolidated)');
    line(`  ❌ FAIL ${classifyHydrationFailTag('unexpected id at index 3', 'unexpected id at index 3')}`);
    line();

    line('[Style F] Fallback — distinct errors from each comparer (both shown)');
    line(`  ❌ FAIL ${classifyHydrationFailTag('dep length mismatch at node comp_0', 'wrong dep target at index 1')}`);
    line();

    // Write the file
    const matrixPath = path.join(LOGS_DIR, 'dataset-output-format-matrix.log');
    fs.writeFileSync(matrixPath, lines.join('\n') + '\n', 'utf8');
    console.log(`[test] Dataset output format matrix written to ${matrixPath}`);

    // Sanity assertions on the generated content
    const content = fs.readFileSync(matrixPath, 'utf8');
    assert.ok(content.includes('Full-detail three-line phase contract'), 'Matrix must include section 1');
    assert.ok(content.includes('Later-tier compact format'), 'Matrix must include section 2');
    assert.ok(content.includes('Hydration failure display styles'), 'Matrix must include section 3');
    assert.ok(content.includes('[Case 1]'), 'Matrix must include Case 1');
    assert.ok(content.includes('[Case 8]'), 'Matrix must include Case 8 (both probes fail)');
    assert.ok(content.includes('[Case 15]'), 'Matrix must include Case 15');
    assert.ok(content.includes('[Style A]'), 'Matrix must include style A');
    assert.ok(content.includes('[Style F]'), 'Matrix must include style F');
    // Verify the "authoritative probe" case is documented
    assert.ok(content.includes('cycle-flat is authoritative'), 'Matrix must document cycle-flat authority');
  });
});

