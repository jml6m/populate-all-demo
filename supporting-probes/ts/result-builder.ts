import fs from 'node:fs';
import path from 'node:path';
import { type ProbeLanguage, PROBE_RUN_ID_PATTERN } from './probe-config';

export type { ProbeLanguage };
export type FindingResult = 'PASS' | 'FAIL';
/** A gate that can also be legitimately skipped when a prerequisite stage did not complete. */
export type GateResult = 'PASS' | 'FAIL' | 'NOT_RUN';
/** The operation under research: the schema-driven fetch. NOT_RUN when setup failed before it. */
export type FetchResult = 'OK' | 'ERROR' | 'NOT_RUN';
export type QueryGateResult = 'PASS' | 'FAIL' | 'NOT_RUN' | 'NOT_APPLICABLE';
export type SerializeResult = 'SERIALIZE_PASS' | 'SERIALIZE_FAIL_CYCLE' | 'SERIALIZE_FAIL_OTHER' | 'SERIALIZE_NOT_RUN';
export type ProbeOutcome = 'PASS' | 'HYDRATION_FAIL' | 'SERIALIZE_FAIL' | 'MIXED' | 'PROBE_LAUNCH_FAIL';

export interface ProbeFindings {
  /**
   * The operation under research — the schema-driven fetch itself. First-class so a
   * fetch that threw is distinct from the hydration rollup. Optional while probes migrate
   * to the staged design; treated as OK-by-omission by consumers until then.
   */
  fetch?: {
    result: FetchResult;
    detail: string;
  };
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
    result: GateResult;
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

/**
 * Findings in a "never reached" state. Each stage of a staged probe overwrites
 * only its own slot, so a stage that never runs keeps an honest NOT_RUN marker
 * instead of inheriting an unrelated error from an earlier failure.
 */
export function pendingFindings(): ProbeFindings {
  const detail = 'not run -- a prerequisite stage did not complete';
  return {
    fetch: { result: 'NOT_RUN', detail },
    hydration: { result: 'FAIL', detail },
    queryGate: { result: 'NOT_RUN', detail },
    smartCheck: { result: 'NOT_RUN', detail },
    serialize: { result: 'SERIALIZE_NOT_RUN', detail },
  };
}

/** Mark the three downstream gates as never-executed with a shared reason. */
export function markGatesNotRun(findings: ProbeFindings, reason: string): void {
  findings.queryGate = { result: 'NOT_RUN', detail: reason };
  findings.smartCheck = { result: 'NOT_RUN', detail: reason };
  findings.serialize = { result: 'SERIALIZE_NOT_RUN', detail: reason };
}

export function buildLaunchFailureFindings(detail: string): ProbeFindings {
  const withDetail = (message: string) => `${message}\n${detail}`;
  return {
    fetch: { result: 'NOT_RUN', detail: withDetail('Probe failed to launch — schema-driven fetch not attempted.') },
    hydration: { result: 'FAIL', detail },
    queryGate: { result: 'NOT_APPLICABLE', detail: withDetail('Probe failed to launch — query gate not exercised.') },
    smartCheck: { result: 'FAIL', detail: withDetail('Probe failed to launch.') },
    serialize: { result: 'SERIALIZE_FAIL_OTHER', detail: withDetail('Probe failed to launch.') },
  };
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

function buildLocalRunId(now: Date): string {
  const y = now.getUTCFullYear().toString();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${d}-${hh}${mm}${ss}-nogit`;
}

export function writeProbeResult(result: ProbeResult): string {
  const existingRunId = process.env.PROBE_RUN_ID?.trim();
  const runId = existingRunId && existingRunId.length > 0 ? existingRunId : buildLocalRunId(new Date());
  process.env.PROBE_RUN_ID = runId;

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
