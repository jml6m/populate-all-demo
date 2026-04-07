import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeFingerprint, isAlreadyUpToDate, ExperimentIndex, RunMetadata } from './runner';
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
});
