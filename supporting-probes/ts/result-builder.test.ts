import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildLaunchFailureFindings } from './result-builder';

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
