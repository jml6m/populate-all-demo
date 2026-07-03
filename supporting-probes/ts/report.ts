import type { ProbeFindings } from './result-builder';

/**
 * Shared console reporter for the TypeScript probes. Emits a fixed-width,
 * ASCII-only block so the same layout renders identically across every probe
 * (and matches the Python/Ruby/Java/C# probes) on both Windows consoles and
 * Linux CI — no box-drawing or arrow glyphs that break cp1252 stdout.
 *
 * The JSON artifact remains the source of truth; this block is a human-facing
 * view that spells out what was exercised and why the verdict landed where it
 * did, so an operator inspecting a run can trust the result without re-deriving it.
 */

const RULE_WIDTH = 64;

/** One-line description of the scenario every probe exercises. */
export const ACYCLIC_SCENARIO = 'acyclic A->B->C | schema-driven full hydration (no query-time include paths)';

export interface ProbeMetrics {
  /** Distinct ids reached from the root during smartCheck. */
  reached: number;
  /** Expected node count (size of the adjacency map). */
  expected: number;
  /** Edges walked during smartCheck. */
  edges: number;
  /** Extra queries observed while traversing an already-hydrated graph. */
  extraQueries?: number;
  /** False when an id resolved to more than one in-memory instance. */
  identityStable?: boolean;
}

export interface ProbeReportInput {
  probe: string;
  library: string;
  libraryVersion: string;
  /** Library-specific fetch/config strategy under test (schema-driven, no per-query paths). */
  strategy: string;
  findings: ProbeFindings;
  jsonPath: string;
  /** Omitted when the probe threw before reaching the traversal stage. */
  metrics?: ProbeMetrics;
  /** Precise, probe-authored verdict reason. Falls back to a reason derived from findings. */
  verdictReason?: string;
}

function rule(label: string): string {
  const prefix = `== ${label} `;
  return prefix + '='.repeat(Math.max(0, RULE_WIDTH - prefix.length));
}

function firstLine(detail: string): string {
  const line = (detail ?? '').split('\n')[0].trim();
  return line.length > 100 ? `${line.slice(0, 99)}...` : line;
}

export function deriveVerdict(findings: ProbeFindings): { verdict: 'ACYCLIC_PASS' | 'ACYCLIC_FAIL'; reason: string } {
  if (findings.hydration.result === 'PASS') {
    return findings.serialize.result === 'SERIALIZE_PASS'
      ? { verdict: 'ACYCLIC_PASS', reason: 'schema-driven full hydration + serialization succeeded' }
      : { verdict: 'ACYCLIC_PASS', reason: `full hydration succeeded; serialization ${findings.serialize.result}` };
  }

  // A staged probe marks downstream gates NOT_RUN and puts the real cause in hydration.detail.
  if (findings.smartCheck.result === 'NOT_RUN') {
    return { verdict: 'ACYCLIC_FAIL', reason: firstLine(findings.hydration.detail) || 'hydration did not complete' };
  }

  const exceptionRaised =
    findings.queryGate.result === 'FAIL' &&
    findings.smartCheck.result === 'FAIL' &&
    findings.hydration.detail === findings.smartCheck.detail &&
    findings.smartCheck.detail === findings.queryGate.detail;
  if (exceptionRaised) {
    return { verdict: 'ACYCLIC_FAIL', reason: `probe raised before traversal -- ${firstLine(findings.hydration.detail)}` };
  }
  if (findings.smartCheck.result === 'FAIL') {
    return { verdict: 'ACYCLIC_FAIL', reason: `smartCheck failed -- ${firstLine(findings.smartCheck.detail)}` };
  }
  if (findings.queryGate.result === 'FAIL') {
    return { verdict: 'ACYCLIC_FAIL', reason: `topology resolved but queryGate failed -- ${firstLine(findings.queryGate.detail)}` };
  }
  return { verdict: 'ACYCLIC_FAIL', reason: 'hydration failed' };
}

function observedLine(metrics?: ProbeMetrics): string {
  if (!metrics) {
    return 'observed : no graph hydrated -- traversal/identity/serialization gates were not run';
  }
  const parts = [`reached ${metrics.reached}/${metrics.expected} expected nodes from root [a]`, `${metrics.edges} edges`];
  parts.push(metrics.identityStable === false ? 'identity BROKEN (duplicate instances)' : 'identity stable');
  if (metrics.extraQueries !== undefined) {
    parts.push(`${metrics.extraQueries} extra queries`);
  }
  return `observed : ${parts.join('; ')}`;
}

export function printProbeReport(input: ProbeReportInput): void {
  const f = input.findings;
  const derived = deriveVerdict(f);
  const verdict = derived.verdict;
  const reason = input.verdictReason ?? derived.reason;

  console.log('');
  console.log(rule(`${input.probe} | ${input.library} v${input.libraryVersion}`));
  console.log(`scenario : ${ACYCLIC_SCENARIO}`);
  console.log(`strategy : ${input.strategy}`);
  console.log(observedLine(input.metrics));
  if (f.fetch) {
    console.log(`  fetch      : ${f.fetch.result.padEnd(7)}  ${firstLine(f.fetch.detail)}`);
  }
  console.log(`  hydration  : ${f.hydration.result.padEnd(7)}  ${firstLine(f.hydration.detail)}`);
  console.log(`  queryGate  : ${f.queryGate.result.padEnd(7)}  ${firstLine(f.queryGate.detail)}`);
  console.log(`  smartCheck : ${f.smartCheck.result.padEnd(7)}  ${firstLine(f.smartCheck.detail)}`);
  console.log(`  serialize  : ${f.serialize.result.padEnd(7)}  ${firstLine(f.serialize.detail)}`);
  console.log(`VERDICT  : ${verdict} -- ${reason}`);
  console.log(`json     : ${input.jsonPath}`);
}
