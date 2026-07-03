import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildLaunchFailureFindings, writeProbeResult } from './result-builder';

describe('buildLaunchFailureFindings', () => {
  it('preserves launch detail on every fallback finding', () => {
    const detail = 'stderr line\nstdout line';
    const findings = buildLaunchFailureFindings(detail);

    assert.deepEqual(findings.hydration, { result: 'FAIL', detail });
    assert.equal(findings.queryGate.result, 'NOT_APPLICABLE');
    assert.match(findings.queryGate.detail, /query gate not exercised/);
    assert.match(findings.queryGate.detail, /stderr line/);
    assert.equal(findings.smartCheck.result, 'FAIL');
    assert.match(findings.smartCheck.detail, /stderr line/);
    assert.equal(findings.serialize.result, 'SERIALIZE_FAIL_OTHER');
    assert.match(findings.serialize.detail, /stdout line/);
  });
});

describe('writeProbeResult', () => {
  it('auto-generates a local run id when PROBE_RUN_ID is absent', () => {
    const previousRunId = process.env.PROBE_RUN_ID;
    const previousCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'supporting-probe-result-builder-'));

    try {
      delete process.env.PROBE_RUN_ID;
      process.chdir(tempDir);

      const outputPath = writeProbeResult({
        probe: 'typeorm',
        language: 'typescript',
        library: 'TypeORM',
        libraryVersion: '0.0.0',
        runtimeVersion: process.version,
        findings: {
          hydration: { result: 'FAIL', detail: 'x' },
          queryGate: { result: 'FAIL', detail: 'x' },
          smartCheck: { result: 'FAIL', detail: 'x' },
          serialize: { result: 'SERIALIZE_FAIL_OTHER', detail: 'x' },
        },
      });

      assert.match(outputPath, /results[\\/]local[\\/][0-9]{8}-[0-9]{6}-nogit[\\/]typeorm\.json$/);
      assert.match(process.env.PROBE_RUN_ID ?? '', /^[0-9]{8}-[0-9]{6}-nogit$/);
      assert.equal(fs.existsSync(outputPath), true);
    } finally {
      if (previousRunId === undefined) {
        delete process.env.PROBE_RUN_ID;
      } else {
        process.env.PROBE_RUN_ID = previousRunId;
      }
      process.chdir(previousCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
