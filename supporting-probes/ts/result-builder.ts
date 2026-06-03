import fs from 'node:fs';
import path from 'node:path';

export type ProbeLanguage = 'typescript' | 'python' | 'ruby' | 'java' | 'csharp';
export type FindingResult = 'PASS' | 'FAIL';
export type QueryGateResult = 'PASS' | 'FAIL' | 'NOT_APPLICABLE';
export type SerializeResult = 'SERIALIZE_PASS' | 'SERIALIZE_FAIL_CYCLE' | 'SERIALIZE_FAIL_OTHER';
export type ProbeOutcome = 'PASS' | 'HYDRATION_FAIL' | 'SERIALIZE_FAIL' | 'MIXED';

export interface ProbeResult {
  probe: string;
  language: ProbeLanguage;
  library: string;
  libraryVersion: string;
  runtimeVersion: string;
  outcome: ProbeOutcome;
  findings: {
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
  };
}

export function buildOutcome(findings: ProbeResult['findings']): ProbeOutcome {
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
    if (error.stack && error.stack.length > 0) {
      return error.stack;
    }
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

export function writeProbeResultForRunId(runId: string, result: ProbeResult): string {
  if (!/^[0-9]{8}-[0-9]{6}-(?:[0-9a-f]{7}|nogit)$/.test(runId) || runId.includes(path.sep)) {
    throw new Error(`Invalid PROBE_RUN_ID '${runId}' (expected YYYYMMDD-HHMMSS-<shortsha>)`);
  }

  const outputDir = path.join(process.cwd(), 'results', 'local', runId);
  fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, `${result.probe}.json`);
  const tmpPath = `${outputPath}.tmp`;
  fs.writeFileSync(tmpPath, serializeSortedJson(result), 'utf8');
  fs.renameSync(tmpPath, outputPath);

  return outputPath;
}
  const tmpPath = `${outputPath}.tmp`;
  fs.writeFileSync(tmpPath, serializeSortedJson(result), 'utf8');
  fs.renameSync(tmpPath, outputPath);

  return outputPath;
}

export function getNodePackageVersion(packageName: string): string {
  const packageJsonPath = path.join(process.cwd(), 'node_modules', packageName, 'package.json');
  const raw = fs.readFileSync(packageJsonPath, 'utf8');
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? 'unknown';
}
