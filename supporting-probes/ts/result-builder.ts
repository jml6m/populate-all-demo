import fs from 'node:fs';
import path from 'node:path';
import { type ProbeLanguage, PROBE_RUN_ID_PATTERN } from './probe-config';

export type { ProbeLanguage };
export type FindingResult = 'PASS' | 'FAIL';
export type QueryGateResult = 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
export type SerializeResult = 'SERIALIZE_PASS' | 'SERIALIZE_FAIL_CYCLE' | 'SERIALIZE_FAIL_OTHER';
export type ProbeOutcome = 'PASS' | 'HYDRATION_FAIL' | 'SERIALIZE_FAIL' | 'MIXED' | 'PROBE_LAUNCH_FAIL';

export interface ProbeFindings {
  hydration: {
    result: FindingResult;
    detail: string;
  };
  queryGate: {
    result: QueryGateResult;
    detail: string;
    extraQueries?: number;
  };
  smartCheck: {
    result: FindingResult;
    detail: string;
  };
  serialize: {
    result: SerializeResult;
    detail: string;
  };
}

/**
 * Probe result written by each probe file.
 * `outcome` is intentionally omitted here — it is always derived from `findings`
 * by `writeProbeResult` / `writeProbeResultForRunId` and stamped into the JSON
 * artifact automatically.
 */
export interface ProbeResult {
  probe: string;
  language: ProbeLanguage;
  library: string;
  libraryVersion: string;
  runtimeVersion: string;
  findings: ProbeFindings;
}

export function buildOutcome(findings: ProbeFindings): ProbeOutcome {
  if (findings.hydration.result === 'FAIL') {
    return 'HYDRATION_FAIL';
  }

  if (findings.serialize.result.startsWith('SERIALIZE_FAIL_')) {
    return 'SERIALIZE_FAIL';
  }

  const allPassed =
    findings.hydration.result === 'PASS' &&
    findings.queryGate.result === 'PASS' &&
    findings.smartCheck.result === 'PASS' &&
    findings.serialize.result === 'SERIALIZE_PASS';

  return allPassed ? 'PASS' : 'MIXED';
}

export function formatErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

export function serializeSortedJson(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }

  if (value !== null && typeof value === 'object') {
    const objectValue = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(objectValue).sort()) {
      sorted[key] = sortKeysDeep(objectValue[key]);
    }
    return sorted;
  }

  return value;
}

export function writeProbeResult(result: ProbeResult): string {
  const runId = process.env.PROBE_RUN_ID;
  if (!runId) {
    throw new Error('PROBE_RUN_ID is required for probe JSON output');
  }

  return writeProbeResultForRunId(runId, result);
}

export function writeProbeResultForRunId(
  runId: string,
  result: ProbeResult,
  options?: { outcomeOverride?: 'PROBE_LAUNCH_FAIL' }
): string {
  if (!PROBE_RUN_ID_PATTERN.test(runId) || runId.includes(path.sep)) {
    throw new Error(`Invalid PROBE_RUN_ID '${runId}' (expected YYYYMMDD-HHMMSS-<shortsha>)`);
  }

  const outputDir = path.join(process.cwd(), 'results', 'local', runId);
  fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `${result.probe}.json`);
  const tmpPath = `${outputPath}.tmp`;
  // Always derive outcome from findings so callers don't need to compute it.
  const resultToWrite = { ...result, outcome: options?.outcomeOverride ?? buildOutcome(result.findings) };
  fs.writeFileSync(tmpPath, serializeSortedJson(resultToWrite), 'utf8');
  fs.renameSync(tmpPath, outputPath);

  return outputPath;
}

export function getNodePackageVersion(packageName: string): string {
  const packageJsonPath = path.join(process.cwd(), 'node_modules', packageName, 'package.json');
  const raw = fs.readFileSync(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? 'unknown';
}
