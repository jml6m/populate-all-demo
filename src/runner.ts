import crypto from 'crypto';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import pkgJson from '../package.json';
import { naiveRecursion } from './algorithms/reference-tracking/01-naive-recursion';
import { mapTracker } from './algorithms/reference-tracking/02-map-tracker';
import { twoPassWire } from './algorithms/schema-driven/01-two-pass-wire';
import { tarjanSccLayering } from './algorithms/topological/01-tarjan-scc-layering';
import { AnswerEntry, ComponentFlat, ComponentPopulated, PopulateAlgorithm } from './algorithms/types';
import { Manifest } from './types';
import { buildPopulatedFromAnswer } from './utils/answer-builder';
import { smartCompare } from './utils/compare';
import { consumerProbes } from './utils/consumer';
import { assertSafePathSegment, loadManifest, loadYaml } from './utils/data-loader';
import { flatCompare } from './utils/flat-compare';
import { validateDataset } from './utils/manifest-validator';

const algorithms: PopulateAlgorithm[] = [naiveRecursion, mapTracker, tarjanSccLayering, twoPassWire];

const INPUT_SUFFIX = '_input';
const ANSWER_SUFFIX = '_answer';

/**
 * The first cyclic dataset tier, used as the baseline for cyclic skip/suppression logic.
 *
 * This is intentionally separate from the first *displayed* dataset (acyclic-control).
 * Algorithms that fail at this tier are skipped on subsequent cyclic tiers (they
 * deterministically fail at all cyclic scales, so re-running adds no information).
 * Probe results from this tier form the reference baseline for later cyclic tiers.
 */
export const CYCLIC_BASELINE_TIER = 'basic';

// ---------------------------------------------------------------------------
// Metadata + report types
// ---------------------------------------------------------------------------

/**
 * Metadata captured once per experiment run.
 *
 * Fields used for the skip/reuse fingerprint decision are documented separately
 * from fields included only for user inspection.
 */
export interface RunMetadata {
  /**
   * Deterministic fingerprint used to decide whether the experiment needs to
   * re-run.  Computed from: manifest content hashes, selected dataset names,
   * algorithm names, consumer probe names, Node.js version, and package version.
   * Platform / timing / memory are NOT part of the fingerprint.
   */
  fingerprint: string;
  /** ISO-8601 timestamp of when this run started.  User context only. */
  runAt: string;
  /** Node.js version string (e.g. "v22.0.0").  Part of the fingerprint. */
  nodeVersion: string;
  /** OS platform (e.g. "linux", "win32").  User context only. */
  platform: string;
  /**
   * Package version from package.json (e.g. "1.0.0").  Part of the fingerprint —
   * bumping the version in package.json invalidates any cached experiment results,
   * which makes code changes (algorithm fixes, probe changes, compare logic) easy
   * to signal without hashing source files directly.
   */
  packageVersion: string;
  /** Dataset tiers included in this run. */
  datasets: string[];
  /** Algorithm names included in this run. */
  algorithms: string[];
  /** Consumer probe names included in this run. */
  probes: string[];
  /** `generatedAt` timestamp from the data manifest.  User context only. */
  manifestGeneratedAt: string;
}

/**
 * Top-level index file written at the end of every successful run to
 * `reports/local/<run-id>/experiment-run.json`.  Used by the next invocation to decide
 * whether to skip.
 */
export interface ExperimentIndex {
  metadata: RunMetadata;
  /** Per-dataset report paths, relative to the current run directory (e.g. "basic/benchmark-1234.json"). */
  reports: Record<string, string>;
}

interface BenchmarkReport {
  algorithmCategory: string;
  algorithmName: string;
  timeComplexity: string;
  spaceComplexity: string;
  dataset: string;
  /**
   * Present and `true` when this algorithm was not executed for this dataset
   * because it deterministically failed at the baseline tier.  `metrics` is
   * `null` for skipped entries — no measurement was taken — so consumers must
   * guard against this before including them in aggregations or plots.
   */
  skipped?: true;
  /**
   * Experiment metrics.  null only for baseline-skipped entries.
   *
   * For hydration failures, `headlineTimeMs` and `headlineRamMb` are null (no
   * meaningful pass to report).  `hydrationTimeMs` is always recorded so the
   * cost of the failed attempt is available for analysis.
   */
  metrics: {
    /**
     * Headline display time: hydration + fastest passing probe (ms).
     * null when hydration failed or when no probe passed, because there is no
     * successful full-run pass to represent.
     */
    headlineTimeMs: number | null;
    /**
     * Headline display RAM: peak heap delta over the full experiment window (MB).
     * null under the same conditions as headlineTimeMs.
     */
    headlineRamMb: number | null;
    /** Hydration-only time: algorithm execution + both comparers (ms). */
    hydrationTimeMs: number;
    /**
     * Per-probe timing in milliseconds.  Keys are probe names.
     * Empty object when probes did not run (hydration failed).
     */
    probeTimingsMs: Record<string, number>;
  } | null;
  /**
   * Stage 1 — Hydration: did the algorithm produce a correct cyclic graph?
   * Verified by two independent comparers (smartCompare + flatCompare).
   */
  hydration: {
    pass: boolean;
    smartCompare: {
      pass: boolean;
      errorDetail: string | null;
      nodesProcessed: number;
      edgesTraversed: number;
    };
    flatCompare: {
      pass: boolean;
      errorDetail: string | null;
    };
    runtimeInvariant: {
      pass: boolean;
      errorDetail: string | null;
      uniqueIds: number;
      uniqueInstances: number;
      edgesTraversed: number;
    };
    doubleVerified: boolean;
  };
  /**
   * Stage 2 — Consumer probes: can the hydrated graph be processed downstream?
   * Only runs when hydration passes.  Each probe tests a different consumer
   * strategy (see src/utils/consumer.ts for the ConsumerProbe abstraction).
   *
   * Key insight: hydration success ≠ consumer viability.  A correctly hydrated
   * cyclic graph still crashes naive consumers (e.g. JSON.stringify).  Only
   * cycle-aware consumers (e.g. index-based export) handle it safely.
   *
   * Each probe is evaluated in two steps:
   *   1. Did it generate a valid output?  (pass / errorDetail)
   *   2. Is that output accurate?  (outputVerification — present when the probe
   *      produced a serializedOutput that was compared against rawAnswerEntries)
   */
  consumerProbes: {
    /** false when hydration failed — consumer probes are skipped. */
    ran: boolean;
    probes: {
      name: string;
      pass: boolean;
      errorDetail: string | null;
      /**
       * Accuracy check of the probe's serialized output against the expected
       * answer entries.  null when the probe does not produce a serializedOutput
       * (e.g. naive-json) or when the probe itself failed.
       */
      outputVerification: {
        pass: boolean;
        errorDetail: string | null;
      } | null;
    }[];
  };
}

/** Shape of a per-dataset report file (wraps results with run metadata). */
interface DatasetReportFile {
  metadata: RunMetadata;
  results: BenchmarkReport[];
}

// --- YAML validation helpers ---

function assertTopLevelArray(raw: unknown, label: string): unknown[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${label}: expected a top-level array, got ${typeof raw}`);
  }
  return raw;
}

function assertEntryRecord(entry: unknown, label: string, i: number): Record<string, unknown> {
  if (entry === null || typeof entry !== 'object') {
    throw new Error(`${label}: entry[${i}] is not an object`);
  }
  return entry as Record<string, unknown>;
}

function assertEntryStringField(e: Record<string, unknown>, field: string, label: string, i: number): string {
  if (typeof e[field] !== 'string') {
    throw new Error(`${label}: entry[${i}].${field} must be a string`);
  }
  return e[field] as string;
}

/**
 * Validates and parses raw YAML output as ComponentFlat[].
 * Throws a descriptive error if the structure does not match the expected schema.
 */
function parseInputData(raw: unknown, filename: string): ComponentFlat[] {
  const label = `Input file "${filename}"`;
  return assertTopLevelArray(raw, label).map((entry, i) => {
    const e = assertEntryRecord(entry, label, i);
    const id = assertEntryStringField(e, 'id', label, i);
    if (!Array.isArray(e['dependencies'])) {
      throw new Error(`${label}: entry[${i}].dependencies must be an array of strings`);
    }
    if ((e['dependencies'] as unknown[]).some((d) => typeof d !== 'string')) {
      throw new Error(`${label}: entry[${i}].dependencies must be an array of strings`);
    }
    return { id, dependencies: e['dependencies'] as string[] };
  });
}

/**
 * Validates and parses raw YAML output as AnswerEntry[].
 * Throws a descriptive error if the structure does not match the expected schema,
 * including out-of-range or non-integer depIndices.
 */
function parseAnswerData(raw: unknown, filename: string): AnswerEntry[] {
  const label = `Answer file "${filename}"`;
  const arr = assertTopLevelArray(raw, label);
  const length = arr.length;
  return arr.map((entry, i) => {
    const e = assertEntryRecord(entry, label, i);
    const id = assertEntryStringField(e, 'id', label, i);
    if (!Array.isArray(e['depIndices'])) {
      throw new Error(`${label}: entry[${i}].depIndices must be an array`);
    }
    const depIndices: number[] = (e['depIndices'] as unknown[]).map((d, j) => {
      if (typeof d !== 'number' || !Number.isInteger(d)) {
        throw new Error(`${label}: entry[${i}].depIndices[${j}]=${JSON.stringify(d)} must be an integer`);
      }
      if (d < 0 || d >= length) {
        throw new Error(`${label}: entry[${i}].depIndices[${j}]=${d} is out of bounds (must be in [0, ${length - 1}])`);
      }
      return d;
    });
    return { id, depIndices };
  });
}

/**
 * Compares a probe-generated AnswerEntry[] against the known-correct raw answer
 * entries loaded from the manifest YAML file.  This is the accuracy check for
 * Stage 2 serialization: verifying that the output the probe produced is not just
 * structurally valid but also topologically correct.
 */
function compareAnswerEntries(generated: AnswerEntry[], expected: AnswerEntry[]): { pass: boolean; errorDetail: string | null } {
  if (generated.length !== expected.length) {
    return {
      pass: false,
      errorDetail: `Length mismatch: generated ${generated.length} entries, expected ${expected.length}`,
    };
  }
  for (let i = 0; i < generated.length; i++) {
    const g = generated[i];
    const e = expected[i];
    if (g.id !== e.id) {
      return {
        pass: false,
        errorDetail: `Entry[${i}] id mismatch: generated "${g.id}", expected "${e.id}"`,
      };
    }
    if (g.depIndices.length !== e.depIndices.length) {
      return {
        pass: false,
        errorDetail: `Entry[${i}] ("${g.id}") depIndices length mismatch: generated ${g.depIndices.length}, expected ${e.depIndices.length}`,
      };
    }
    for (let j = 0; j < g.depIndices.length; j++) {
      if (g.depIndices[j] !== e.depIndices[j]) {
        return {
          pass: false,
          errorDetail: `Entry[${i}] ("${g.id}") depIndices[${j}] mismatch: generated ${g.depIndices[j]}, expected ${e.depIndices[j]}`,
        };
      }
    }
  }
  return { pass: true, errorDetail: null };
}

export interface RuntimeHydrationInvariantResult {
  pass: boolean;
  errorDetail: string | null;
  uniqueIds: number;
  uniqueInstances: number;
  edgesTraversed: number;
}

interface RuntimeHydrationExpectedIndex {
  byId: Map<string, Set<string>>;
  edgeCount: number;
  nodeCount: number;
}

interface RuntimeHydrationExpectedIndexError {
  errorDetail: string;
  uniqueIds: number;
  edgesTraversed: number;
}

function buildRuntimeHydrationExpectedIndex(expected: AnswerEntry[]): RuntimeHydrationExpectedIndex | RuntimeHydrationExpectedIndexError {
  const byId = new Map<string, Set<string>>();
  let edgeCount = 0;
  for (const entry of expected) {
    if (byId.has(entry.id)) {
      return { errorDetail: `Invariant: duplicate expected id "${entry.id}"`, uniqueIds: byId.size, edgesTraversed: edgeCount };
    }
    const depIds = new Set<string>();
    for (const depIdx of entry.depIndices) {
      if (!Number.isInteger(depIdx) || depIdx < 0 || depIdx >= expected.length) {
        return {
          errorDetail: `Invariant: invalid dependency index ${depIdx} for id "${entry.id}"`,
          uniqueIds: byId.size,
          edgesTraversed: edgeCount,
        };
      }
      depIds.add(expected[depIdx].id);
      edgeCount++;
    }
    byId.set(entry.id, depIds);
  }
  return { byId, edgeCount, nodeCount: expected.length };
}

/**
 * Runtime hydration invariant (computed on live object references, not serialization).
 *
 * Definition of "fully hydrated" for this experiment:
 *  1) Exactly one live object instance exists per logical id.
 *  2) All expected ids and edges from the answer closure are present as live pointers.
 *  3) Traversed nodes are plain objects with array dependencies (no lazy/proxy wrappers).
 *
 * Note: this remains a runtime guard (instead of a constructor/type-level guarantee)
 * because algorithm outputs come from dynamic implementations at execution time.
 */
export function runtimeHydrationInvariant(
  actual: ComponentPopulated[],
  expected: AnswerEntry[],
  precomputed?: RuntimeHydrationExpectedIndex
): RuntimeHydrationInvariantResult {
  if (!Array.isArray(actual) || !Array.isArray(expected)) {
    return { pass: false, errorDetail: 'Invariant: actual and expected must be arrays', uniqueIds: 0, uniqueInstances: 0, edgesTraversed: 0 };
  }

  const expectedIndex = precomputed ?? buildRuntimeHydrationExpectedIndex(expected);
  if ('errorDetail' in expectedIndex) {
    return {
      pass: false,
      errorDetail: expectedIndex.errorDetail,
      uniqueIds: expectedIndex.uniqueIds,
      uniqueInstances: 0,
      edgesTraversed: expectedIndex.edgesTraversed,
    };
  }

  const stack: ComponentPopulated[] = [...actual];
  const visited = new Set<ComponentPopulated>();
  const idToObject = new Map<string, ComponentPopulated>();
  let edgesTraversed = 0;

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);

    if (Object.getPrototypeOf(node) !== Object.prototype) {
      return { pass: false, errorDetail: `Invariant: node "${node.id}" is not a plain object`, uniqueIds: idToObject.size, uniqueInstances: visited.size, edgesTraversed };
    }

    if (typeof node.id !== 'string') {
      return { pass: false, errorDetail: `Invariant: encountered node with non-string id`, uniqueIds: idToObject.size, uniqueInstances: visited.size, edgesTraversed };
    }

    if (!Array.isArray(node.dependencies)) {
      return { pass: false, errorDetail: `Invariant: node "${node.id}" has non-array dependencies`, uniqueIds: idToObject.size, uniqueInstances: visited.size, edgesTraversed };
    }

    const existing = idToObject.get(node.id);
    if (existing !== undefined && existing !== node) {
      return {
        pass: false,
        errorDetail: `Invariant: id "${node.id}" maps to multiple object instances`,
        uniqueIds: idToObject.size,
        uniqueInstances: visited.size,
        edgesTraversed,
      };
    }
    idToObject.set(node.id, node);

    const expectedDepIds = expectedIndex.byId.get(node.id);
    if (expectedDepIds === undefined) {
      return {
        pass: false,
        errorDetail: `Invariant: unexpected reachable id "${node.id}"`,
        uniqueIds: idToObject.size,
        uniqueInstances: visited.size,
        edgesTraversed,
      };
    }

    const actualDepIds = new Set<string>();
    for (const dep of node.dependencies) {
      edgesTraversed++;
      if (typeof dep.id !== 'string') {
        return {
          pass: false,
          errorDetail: `Invariant: node "${node.id}" has invalid dependency shape`,
          uniqueIds: idToObject.size,
          uniqueInstances: visited.size,
          edgesTraversed,
        };
      }
      actualDepIds.add(dep.id);
      stack.push(dep);
    }

    if (actualDepIds.size !== expectedDepIds.size || [...actualDepIds].some((id) => !expectedDepIds.has(id))) {
      return {
        pass: false,
        errorDetail: `Invariant: dependency closure mismatch at id "${node.id}"`,
        uniqueIds: idToObject.size,
        uniqueInstances: visited.size,
        edgesTraversed,
      };
    }
  }

  const expectedEdgeCount = expectedIndex.edgeCount;
  if (idToObject.size !== expectedIndex.nodeCount) {
    return {
      pass: false,
      errorDetail: `Invariant: reachable ids ${idToObject.size}/${expectedIndex.nodeCount}`,
      uniqueIds: idToObject.size,
      uniqueInstances: visited.size,
      edgesTraversed,
    };
  }
  if (edgesTraversed !== expectedEdgeCount) {
    return {
      pass: false,
      errorDetail: `Invariant: reachable edges ${edgesTraversed}/${expectedEdgeCount}`,
      uniqueIds: idToObject.size,
      uniqueInstances: visited.size,
      edgesTraversed,
    };
  }

  return {
    pass: true,
    errorDetail: null,
    uniqueIds: idToObject.size,
    uniqueInstances: visited.size,
    edgesTraversed,
  };
}

// ANSI blue: wraps the entire formatted value so the numeric portion is consistently blue.
// Colors are only applied when stdout is a TTY — log files and piped output remain clean.
const BLUE = '\x1b[34m';
const RESET = '\x1b[0m';
const USE_COLOR = process.stdout.isTTY === true;

function colorizeBlue(value: string): string {
  return USE_COLOR ? `${BLUE}${value}${RESET}` : value;
}

// Time: sub-0.1ms is below timing noise floor; scale units at 1s and 60s.
function formatTime(ms: number): string {
  if (ms < 0.1) return colorizeBlue('< 0.1ms');
  if (ms < 10) return colorizeBlue(`${ms.toFixed(1)}ms`);
  if (ms < 1000) return colorizeBlue(`${Math.round(ms)}ms`);
  if (ms < 60000) return colorizeBlue(`${(ms / 1000).toFixed(1)}s`);
  return colorizeBlue('> 60s');
}

// RAM: sub-0.1 MB heap deltas are within measurement noise; scale to GB at 1024 MB.
function formatRam(mb: number): string {
  if (mb < 0.1) return colorizeBlue('< 0.1 MB');
  if (mb < 10) return colorizeBlue(`${mb.toFixed(1)} MB`);
  if (mb < 1000) return colorizeBlue(`${Math.round(mb)} MB`);
  return colorizeBlue(`${(mb / 1024).toFixed(1)} GB`);
}

// ---------------------------------------------------------------------------
// Failure-detail formatting helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Maximum length for any single error detail string stored in experiment
 * results or displayed in console output.  All error messages coming from
 * comparers and caught exceptions are capped at this length before they are
 * stored, so display helpers never need to truncate again.
 */
export const MAX_ERROR_DETAIL_CHARS = 80;

/**
 * Caps an error detail string at MAX_ERROR_DETAIL_CHARS and normalises
 * embedded newlines to spaces.  Returns null when input is null.
 */
export function capErrorDetail(msg: string | null): string | null {
  if (msg === null) return null;
  return msg.replace(/\r?\n/g, ' ').substring(0, MAX_ERROR_DETAIL_CHARS);
}

/**
 * Formats the error tag(s) for a full-run failure summary line.
 *
 * When both comparers fail with the same error text, consolidates to a single
 * `[both comparers: …]` tag so the same message is not repeated twice.
 * When they differ, returns individual tags for each comparer.
 *
 * Expects error strings that have already been capped via capErrorDetail —
 * no additional truncation is applied here.
 *
 * @param smartErr - errorDetail from smartCompare (null if comparer passed or no detail)
 * @param flatErr  - errorDetail from flatCompare  (null if comparer passed or no detail)
 */
export function formatHydrationFailTag(smartErr: string | null, flatErr: string | null): string {
  if (smartErr !== null && flatErr !== null && smartErr === flatErr) {
    return `[both comparers: ${smartErr}]`;
  }

  const parts: string[] = [];
  if (smartErr !== null) parts.push(`[smartCompare: ${smartErr}]`);
  if (flatErr !== null) parts.push(`[flatCompare: ${flatErr}]`);
  return parts.join(' ');
}

/**
 * Builds de-duplicated failure detail lines for a hydration failure.
 *
 * When both comparers produce the same error message, returns one combined
 * line instead of printing the same error twice.  When they differ, returns
 * individual lines for each failing comparer.
 *
 * Expects error strings that have already been capped via capErrorDetail —
 * no additional truncation is applied here.
 *
 * @param smartErr   - errorDetail from smartCompare (null if passed or no detail)
 * @param flatErr    - errorDetail from flatCompare  (null if passed or no detail)
 */
export function buildFailureDetailLines(smartErr: string | null, flatErr: string | null): string[] {
  if (smartErr !== null && flatErr !== null && smartErr === flatErr) {
    return [`  Both comparers: ${smartErr}...`];
  }

  const lines: string[] = [];
  if (smartErr !== null) lines.push(`  smartCompare Error: ${smartErr}...`);
  if (flatErr !== null) lines.push(`  flatCompare Error: ${flatErr}...`);
  return lines;
}

/**
 * Returns a clean display tag for a hydration failure.
 *
 * Stack-overflow errors (the common case) keep the existing bracket-tag format
 * because "Maximum call stack size exceeded" is already informative.
 *
 * Non-stack-overflow errors — such as identity/reference-sharing mismatches
 * detected by smartCompare — replace the raw comparer output with a concise,
 * developer-meaningful phrase rather than dumping clipped low-level detail.
 *
 * Raw error details are always preserved in the per-dataset report JSON.
 */
export function classifyHydrationFailTag(smartErr: string | null, flatErr: string | null): string {
  const combined = `${smartErr ?? ''} ${flatErr ?? ''}`.toLowerCase();

  // Stack overflow: keep the bracket-tag format (already concise and actionable).
  if (combined.includes('maximum call stack') || combined.includes('call stack size')) {
    return formatHydrationFailTag(smartErr, flatErr);
  }

  // Identity / reference-sharing mismatch: clean developer-meaningful phrase.
  if (combined.includes('cycle structure mismatch') || combined.includes('is paired with more than one') || combined.includes('not present in the top-level')) {
    return '— shared references were duplicated';
  }

  // Other errors: fall back to the bracket-tag format.
  return formatHydrationFailTag(smartErr, flatErr);
}

// ---------------------------------------------------------------------------
// Full-detail phase state — normalization (raw flags → named state object)
//
// Separates the two responsibilities that were previously interleaved at the
// call site:
//   - Normalization: inspect raw result flags, produce a FullDetailPhaseState.
//   - Rendering:     accept a FullDetailPhaseState, produce display strings.
//
// The three buildDetail* helpers below are the render layer.
// The normalizeFullDetailPhaseState function is the normalization layer.
// renderFullDetailLines is the convenience wrapper that combines them.
// ---------------------------------------------------------------------------

/**
 * Normalized representation of a single full-detail dataset algorithm run,
 * ready for rendering via the three-line phase contract helpers.
 *
 * This type captures **what happened** (semantic outcome) rather than **how to
 * display it** (strings).  Keeping it separate from the render helpers means
 * tests can verify the normalized state independently of formatting details,
 * and the render helpers can be called with a clean, unambiguous contract.
 */
export interface FullDetailPhaseState {
  /**
   * The two hydration comparers disagree (one passes, one fails).
   * When true, all other outcome fields are overridden — the conflict is
   * always the top-level display for every line of the three-line contract.
   */
  comparersConflict: boolean;
  /**
   * Both hydration comparers passed.
   * Prerequisite for consumer probes to run.
   * When false (and no conflict), the Hydration line shows ❌ FAIL.
   */
  hydrationPassed: boolean;
  /**
   * Consumer probes actually ran.
   * True only when hydrationPassed is true; false otherwise (probes cannot
   * run when hydration failed or the comparers conflicted).
   */
  probesRan: boolean;
  /**
   * End-to-end experiment passed: hydration AND the authoritative consumer
   * probe (cycle-flat) both passed.
   *
   * This is the definitive pass/fail for the Full Run line:
   *   - true  → Full Run: ✅ PASS with headline metrics
   *   - false → Full Run: ❌ FAIL  (when hydration passed, cycle-flat failed)
   *   - false → Full Run: not run  (when hydration itself failed)
   *
   * naive-json failure alone does NOT affect this flag — only cycle-flat is
   * authoritative for the end-to-end experiment outcome.
   */
  endToEndPass: boolean;
  /**
   * Pre-classified hydration result text produced by the normalization step.
   * Examples: "✅ PASS" or "❌ FAIL [both comparers: …]".
   * Ignored when comparersConflict is true (the conflict label overrides it).
   */
  hydrationResultText: string;
  /**
   * Space-joined probe summary string.
   * Example: "✅ naive-json  ✅ cycle-flat (output ✅)"
   * Only displayed when probesRan is true.
   */
  probeSummaryText: string;
  /** Headline timing in ms (hydration + fastest passing probe). Used on Full Run ✅ PASS only. */
  headlineTimeMs: number;
  /** Peak heap delta in MB. Used on Full Run ✅ PASS only. */
  headlineRamMb: number;
}

/**
 * Constructs a {@link FullDetailPhaseState} from the raw result flags of a
 * single algorithm run on a full-detail dataset.
 *
 * This is the **normalization step**: it accepts raw booleans and pre-formatted
 * strings, and returns a typed state object that the render helpers can consume
 * without interpreting any further flag combinations.
 *
 * @param hydrationPassed     - Both hydration comparers passed.
 * @param comparersConflict   - The two comparers disagreed (one pass, one fail).
 * @param endToEndPass        - Hydration AND cycle-flat (authoritative probe) passed.
 * @param probesRan           - Consumer probes ran (requires hydrationPassed).
 * @param hydrationResultText - Pre-classified hydration result text.
 * @param probeSummaryText    - Space-joined probe summary string.
 * @param headlineTimeMs      - Headline timing in ms.
 * @param headlineRamMb       - Peak heap delta in MB.
 */
export function normalizeFullDetailPhaseState(
  hydrationPassed: boolean,
  comparersConflict: boolean,
  endToEndPass: boolean,
  probesRan: boolean,
  hydrationResultText: string,
  probeSummaryText: string,
  headlineTimeMs: number,
  headlineRamMb: number
): FullDetailPhaseState {
  // Clamp to enforce structural invariants that the render helpers rely on:
  //   - A conflict means neither comparer accepted the output, so hydration cannot
  //     be considered passing, probes cannot have run, and there is no end-to-end pass.
  //   - Probes require hydration to pass; end-to-end pass requires probes to have run.
  // These invariants always hold in the runner, but clamping here makes the function
  // a true normalization step — it produces a self-consistent state from any input.
  const effectiveHydrationPassed = comparersConflict ? false : hydrationPassed;
  const effectiveProbesRan = effectiveHydrationPassed ? probesRan : false;
  const effectiveEndToEndPass = effectiveProbesRan ? endToEndPass : false;

  return {
    comparersConflict,
    hydrationPassed: effectiveHydrationPassed,
    probesRan: effectiveProbesRan,
    endToEndPass: effectiveEndToEndPass,
    hydrationResultText,
    probeSummaryText,
    headlineTimeMs,
    headlineRamMb,
  };
}

// ---------------------------------------------------------------------------
// Full-detail dataset three-line phase contract helpers (exported for testing)
//
// These are the **render layer**: each function accepts the subset of
// FullDetailPhaseState it needs and returns exactly one display string.
// Call renderFullDetailLines to produce all three lines from a state object
// without having to pass individual flags to each helper separately.
// ---------------------------------------------------------------------------

/**
 * Builds the `Hydration:` line for a full-detail dataset.
 *
 * Always uses the `Hydration:` prefix regardless of outcome (the Full Run line
 * carries pass/metrics when the experiment succeeds).
 *
 * @param bothPass    - Whether both hydration comparers passed.
 * @param disagree    - Whether the two comparers disagree (one pass, one fail).
 * @param resultLine  - Pre-formatted result text (e.g. "✅ PASS" or "❌ FAIL [...]").
 */
export function buildDetailHydrationLine(bothPass: boolean, disagree: boolean, resultLine: string): string {
  if (disagree) return `  Hydration:     🚨 CONFLICT — comparers disagree`;
  void bothPass; // resultLine already encodes the pass/fail state
  return `  Hydration:     ${resultLine}`;
}

/**
 * Builds the `Consumer probes:` line for a full-detail dataset.
 *
 * @param probesRan    - Whether consumer probes actually ran (requires hydration pass).
 * @param probeSummary - Space-joined probe result string when probes ran (ignored otherwise).
 * @param disagree     - Whether this is a conflict (affects the "not run" reason phrase).
 */
export function buildDetailConsumerProbesLine(probesRan: boolean, probeSummary: string, disagree = false): string {
  if (!probesRan) {
    return disagree ? `  Consumer probes: not run (comparers conflicted)` : `  Consumer probes: not run (hydration failed)`;
  }
  return `  Consumer probes: ${probeSummary}`;
}

/**
 * Builds the `Full Run:` line for a full-detail dataset.
 *
 * @param endToEndPass   - Whether hydration AND the authoritative probe (cycle-flat) passed.
 * @param bothPass       - Whether both hydration comparers passed.
 * @param disagree       - Whether the comparers conflicted (overrides other outcomes).
 * @param headlineTimeMs - Headline timing (hydration + fastest passing probe) in ms.
 * @param headlineRamMb  - Peak heap delta over the full experiment window (MB).
 */
export function buildDetailFullRunLine(endToEndPass: boolean, bothPass: boolean, disagree: boolean, headlineTimeMs: number, headlineRamMb: number): string {
  if (disagree) return `  Full Run:      🚨 CONFLICT`;
  if (!bothPass) return `  Full Run:      not run (hydration failed)`;
  if (endToEndPass) {
    return `  Full Run:      ✅ PASS | Time: ${formatTime(headlineTimeMs)} | RAM: ${formatRam(headlineRamMb)}`;
  }
  // Hydration passed but the authoritative consumer probe (cycle-flat) failed.
  // cycle-flat is the only probe that is authoritative for the end-to-end result;
  // naive-json failure alone never reaches this branch.
  return `  Full Run:      ❌ FAIL`;
}

/**
 * Renders all three lines of the full-detail three-line phase contract from a
 * {@link FullDetailPhaseState}.
 *
 * Returns `[hydrationLine, probesLine, fullRunLine]` — always exactly three
 * strings, matching the canonical display order:
 *   Hydration → Consumer probes → Full Run
 *
 * Use this in production code instead of calling `buildDetailHydrationLine`,
 * `buildDetailConsumerProbesLine`, and `buildDetailFullRunLine` separately.
 * It ensures all three lines are produced from the same state object and
 * cannot silently diverge (e.g. one line seeing a different `bothPass` value
 * than another).
 */
export function renderFullDetailLines(state: FullDetailPhaseState): [string, string, string] {
  return [
    buildDetailHydrationLine(state.hydrationPassed, state.comparersConflict, state.hydrationResultText),
    buildDetailConsumerProbesLine(state.probesRan, state.probeSummaryText, state.comparersConflict),
    buildDetailFullRunLine(state.endToEndPass, state.hydrationPassed, state.comparersConflict, state.headlineTimeMs, state.headlineRamMb),
  ];
}

// Later-dataset output helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/** Describes a single algorithm's outcome on a later (non-baseline) dataset. */
export interface LaterAlgoOutcome {
  algoName: string;
  algoCategory: string;
  /** True when not executed because the algorithm failed at the baseline tier. */
  baselineSkipped: boolean;
  /**
   * True when the algorithm failed and its failure was already fully documented
   * on a prior dataset (baseline or subsequent).  Suppressed here to avoid
   * repeating the same information.
   */
  knownPriorFailure: boolean;
  /**
   * True when the algorithm fails for the first time on this dataset — a new
   * divergence from prior passing behavior (or a changed failure fingerprint).
   */
  isNewFailure: boolean;
  /**
   * True when the two comparers disagree on this dataset (one passes, one fails).
   * Conflicts are always surfaced as notable outcome changes — they are never
   * suppressed or collapsed into the stable-pass summary.
   */
  isConflict: boolean;
  /**
   * True when hydration passed but the authoritative consumer probe (cycle-flat)
   * failed or was not run.  Used to trigger the phase-oriented two-line format
   * ("Hydration: ✅ PASS" + probe fail detail) instead of the compact
   * "Full Run: ✅ PASS" format with headline metrics.
   * naive-json failures alone do not set this flag — they are expected on cyclic
   * graphs and are not authoritative for the experiment outcome.
   */
  probesFailed: boolean;
  /**
   * Full formatted hydration line ready for console output.
   * - Pass (endToEndPass):  "  Full Run:      ✅ PASS | Time: 22ms | RAM: 9.1 MB"
   *                         (Time is hydration + fastest authoritative passing probe.)
   * - Fail:                 "  Hydration:     ❌ FAIL [both comparers: ...]"  (no metrics)
   * null only when baselineSkipped is true.
   */
  hydrationLine: string | null;
  /** De-duplicated failure detail lines (non-empty only when isNewFailure is true). */
  failureDetailLines: string[];
  /**
   * Probe result/change line, or null when probes are unchanged / not applicable.
   * - Failed:              "  Consumer probes: ❌ FAIL — ❌ naive-json  ✅ cycle-flat"
   * - Changed (all pass):  "  Consumer probes: ⚠️  changed from baseline — ✅ ..."
   */
  probeChangeLine: string | null;
}

/**
 * Formats the console output lines for a later (non-baseline) dataset.
 * Returns an array of lines (no trailing newlines).
 *
 * Formatting rules:
 *  - Baseline-skipped and known-prior-failure algorithms are noted compactly as
 *    a single "Known failure(s) omitted: …" line.
 *  - New failures (hydration newly fails) are printed as a single
 *    "Hydration: ❌ FAIL [...]" line — no "changed" indicator, no metrics.
 *  - Hydration-pass / authoritative-probe-fail algorithms are printed as two lines:
 *    "Hydration: ✅ PASS" followed by the consumer probes fail line.
 *    naive-json failures alone do NOT trigger this format — they are expected
 *    on cyclic graphs and are informational rather than pass/fail-defining.
 *  - Conflicts (comparers disagree) are always printed as full blocks — they are
 *    never suppressed, as disagreement between comparers is always notable.
 *  - Stable passing algorithms are:
 *      · Collapsed to a single "… continued to pass — experiment stable." sentence
 *        ONLY when no algorithms are omitted, no new failures, and no conflicts
 *        (a truly clean tier where every algorithm ran and passed).
 *      · Shown as individual compact entries (hydration line + timing) in all
 *        other cases — when any algorithm is omitted (baseline-skipped or
 *        known-prior failure), so the full survivor picture is always visible.
 */
export function buildLaterDatasetLines(outcomes: LaterAlgoOutcome[]): string[] {
  const lines: string[] = [];

  const omitted = outcomes.filter((o) => o.baselineSkipped || o.knownPriorFailure);
  const newFails = outcomes.filter((o) => o.isNewFailure);
  const conflicts = outcomes.filter((o) => o.isConflict);
  const stablePasses = outcomes.filter((o) => !o.baselineSkipped && !o.knownPriorFailure && !o.isNewFailure && !o.isConflict);

  // ── Compact note for omitted algorithms ──────────────────────────────────
  if (omitted.length > 0) {
    const names = omitted.map((o) => o.algoName).join(', ');
    const label = omitted.length === 1 ? 'Known failure omitted' : 'Known failures omitted';
    lines.push(`  ${label}: ${names}`);
  }

  if (newFails.length === 0 && conflicts.length === 0 && omitted.length === 0) {
    // Nothing materially changed — collapse passing algorithms to a compact
    // summary sentence (avoids repeating blocks that add no new information).
    if (stablePasses.length > 0) {
      const count = stablePasses.length;
      const algoWord = count === 1 ? 'algorithm' : 'algorithms';
      lines.push(`  ${count} ${algoWord} continued to pass — experiment stable.`);
    }
  } else {
    // Something changed or dropped out — show individual entries so the
    // full survivor picture is visible.

    // Conflicts: full block (comparers disagreeing is always notable).
    // Emit the canonical two-line conflict block directly; hydrationLine is not used here.
    for (const c of conflicts) {
      lines.push(`[${c.algoCategory}] ${c.algoName}`);
      lines.push(`  Hydration:     🚨 CONFLICT — comparers disagree`);
      lines.push(`  Full Run:      🚨 CONFLICT`);
      if (c.probeChangeLine !== null) lines.push(c.probeChangeLine);
    }

    // New failures: hydration-fail line + explicit consumer probes status.
    for (const f of newFails) {
      lines.push(`[${f.algoCategory}] ${f.algoName}`);
      if (f.hydrationLine !== null) lines.push(f.hydrationLine);
      for (const dl of f.failureDetailLines) lines.push(dl);
      // Always show consumer probes status for new failures.
      // In practice probeChangeLine is null here (probes cannot run when hydration fails),
      // so the "not run" fallback is the normal path.
      if (f.probeChangeLine !== null) {
        lines.push(f.probeChangeLine);
      } else {
        lines.push(`  Consumer probes: not run (hydration failed)`);
      }
    }

    // Stable passes: compact entries with timing (scalability story).
    for (const p of stablePasses) {
      lines.push(`[${p.algoCategory}] ${p.algoName}`);
      if (p.probesFailed) {
        // Hydration passed but probes failed — two-line phase-oriented output.
        lines.push(`  Hydration:     ✅ PASS`);
        if (p.probeChangeLine !== null) lines.push(p.probeChangeLine);
      } else {
        if (p.hydrationLine !== null) lines.push(p.hydrationLine);
        if (p.probeChangeLine !== null) lines.push(p.probeChangeLine);
      }
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Hydration display line helper (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Builds the formatted console line for a hydration / full-run result.
 *
 * Rules:
 *  - Hydration FAIL  → "  Hydration:     ❌ FAIL [...]"     (no metrics — nothing passed)
 *  - Full-run PASS   → "  Full Run:      ✅ PASS (...) | Time: X | RAM: Y"
 *                       Time is hydration + fastest passing probe.
 *  - Hydration PASS,
 *    but authoritative probe failed
 *                    → "  Hydration:     ✅ PASS"            (probes failed; no headline metric)
 *
 * @param bothPass       - Whether both hydration comparers passed.
 * @param endToEndPass   - Whether hydration AND the authoritative probe (cycle-flat) passed.
 * @param resultLine     - Pre-formatted result text (e.g. "✅ PASS" or "❌ FAIL [...]").
 * @param headlineTimeMs - Headline timing in ms (hydration + fastest passing probe).
 * @param headlineRamMb  - Peak heap delta over the full experiment window (MB).
 */
export function buildFullRunLine(bothPass: boolean, endToEndPass: boolean, resultLine: string, headlineTimeMs: number, headlineRamMb: number): string {
  if (!bothPass) {
    // Hydration failed — always use "Hydration:" label, never show metrics.
    return `  Hydration:     ${resultLine}`;
  }
  if (endToEndPass) {
    // Full experiment passed (hydration + authoritative probe) — show headline metrics.
    return `  Full Run:      ${resultLine} | Time: ${formatTime(headlineTimeMs)} | RAM: ${formatRam(headlineRamMb)}`;
  }
  // Hydration passed but the authoritative probe (cycle-flat) failed — show hydration
  // pass state without a "Full Run:" headline; probe detail appears on the next line.
  return `  Hydration:     ✅ PASS`;
}

// ---------------------------------------------------------------------------
// Reports cleanup helper (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Deletes stale `benchmark-*.json` files in a per-dataset report directory,
 * optionally keeping one specified file (the newly-written report).
 *
 * Call this AFTER writing the new report so the latest artifact is always on disk
 * before any cleanup occurs.  Pass `keepFilename` to preserve the just-written file.
 *
 * @param datasetReportsDir - Absolute path to the per-dataset reports directory.
 * @param keepFilename      - Optional filename (not full path) to exclude from deletion.
 * @returns The number of files deleted.
 */
export function cleanDatasetReports(datasetReportsDir: string, keepFilename?: string): number {
  if (!fs.existsSync(datasetReportsDir)) return 0;
  let deleted = 0;
  for (const file of fs.readdirSync(datasetReportsDir)) {
    if (/^benchmark-\d+\.json$/.test(file) && file !== keepFilename) {
      fs.unlinkSync(path.join(datasetReportsDir, file));
      deleted++;
    }
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Fingerprint + idempotency helpers
// ---------------------------------------------------------------------------

/**
 * Computes a deterministic fingerprint for an experiment configuration.
 *
 * Inputs that affect outcomes and are therefore included:
 *   - Content hashes of every data file for the selected datasets (from the manifest)
 *   - The `generatedAt` timestamp of the manifest (catches regenerations)
 *   - Selected dataset names, algorithm names, and probe names (sorted for stability)
 *   - Node.js version (stack-overflow thresholds are engine-specific)
 *   - `package.json` version (bumping the version is the intended signal for code changes —
 *     algorithm fixes, compare logic changes, probe changes — without hashing source files)
 *
 * Inputs that are volatile and intentionally excluded:
 *   - Wall-clock time, RAM measurements, OS platform, run timestamps
 */
export function computeFingerprint(manifest: Manifest, datasets: string[], algorithmNames: string[], probeNames: string[]): string {
  const relevantFileHashes = Object.fromEntries(
    Object.entries(manifest.files)
      .filter(([k]) => datasets.some((d) => k === `${d}${INPUT_SUFFIX}` || k === `${d}${ANSWER_SUFFIX}`))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, v?.contentHash ?? null])
  );

  const input = JSON.stringify({
    manifestGeneratedAt: manifest.generatedAt,
    fileHashes: relevantFileHashes,
    datasets: [...datasets].sort(),
    algorithms: [...algorithmNames].sort(),
    probes: [...probeNames].sort(),
    nodeVersion: process.version,
    packageVersion: pkgJson.version,
  });

  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function getGitShortSha(projectRoot: string): string {
  try {
    const shortSha = execSync('git rev-parse --short=7 HEAD', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return shortSha.length > 0 ? shortSha : 'nogit';
  } catch {
    return 'nogit';
  }
}

export function makeRunId(runStartedAt: Date, projectRoot: string): string {
  const yyyy = String(runStartedAt.getUTCFullYear());
  const mm = String(runStartedAt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(runStartedAt.getUTCDate()).padStart(2, '0');
  const hh = String(runStartedAt.getUTCHours()).padStart(2, '0');
  const min = String(runStartedAt.getUTCMinutes()).padStart(2, '0');
  const ss = String(runStartedAt.getUTCSeconds()).padStart(2, '0');
  const shortSha = getGitShortSha(projectRoot);
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}-${shortSha}`;
}

/**
 * Returns true when the most recent `reports/local/<run-id>/experiment-run.json`
 * index matches the current fingerprint AND every referenced per-dataset report
 * file exists on disk.
 */
export function isAlreadyUpToDate(reportsLocalDir: string, fingerprint: string, datasets: string[]): boolean {
  if (!fs.existsSync(reportsLocalDir)) return false;

  const runIds = fs
    .readdirSync(reportsLocalDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const latestRunId = runIds.at(-1);
  if (latestRunId === undefined) return false;

  const latestRunDir = path.join(reportsLocalDir, latestRunId);
  const indexPath = path.join(latestRunDir, 'experiment-run.json');
  if (!fs.existsSync(indexPath)) return false;

  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ExperimentIndex;
    if (index.metadata.fingerprint !== fingerprint) return false;

    for (const dataset of datasets) {
      const reportRelPath = index.reports[dataset];
      if (typeof reportRelPath !== 'string') return false;
      // Guard against path traversal: the resolved path must stay within latestRunDir.
      const absPath = path.resolve(latestRunDir, reportRelPath);
      const rel = path.relative(latestRunDir, absPath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
      if (!fs.existsSync(absPath)) return false;
    }

    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main benchmark runner
// ---------------------------------------------------------------------------

/**
 * Returns true when force mode is active.
 *
 * Force mode is detected via the `POPULATE_ALL_FORCE` environment variable set
 * to `"1"`.  Use `npm run experiment:force` to activate it — this is more
 * reliable than passing `--force` directly through npm, which intercepts that
 * flag before the Node process can see it.
 */
export function isForceMode(): boolean {
  return process.env['POPULATE_ALL_FORCE'] === '1';
}

function runBenchmark() {
  const manifest = loadManifest();
  const projectRoot = path.resolve(__dirname, '..');
  const reportsLocalDir = path.join(projectRoot, 'reports', 'local');

  // Derive dataset names from manifest keys (e.g. "basic_input" -> "basic")
  const allDatasets = [
    ...new Set(
      Object.keys(manifest.files)
        .filter((key) => key.endsWith(INPUT_SUFFIX))
        .map((key) => key.slice(0, -INPUT_SUFFIX.length))
    ),
  ];

  // Parse --tier CLI argument to optionally filter datasets
  const tierArgIndex = process.argv.indexOf('--tier');
  let datasets: string[];
  if (tierArgIndex !== -1) {
    const tierName = process.argv.at(tierArgIndex + 1);
    if (tierName === undefined || tierName.startsWith('--')) {
      throw new Error(`--tier requires a tier name argument (e.g. --tier basic)`);
    }
    if (!allDatasets.includes(tierName)) {
      throw new Error(`Tier "${tierName}" not found in manifest. Available tiers: ${allDatasets.join(', ')}`);
    }
    datasets = [tierName];
  } else {
    datasets = allDatasets;
  }

  // Force mode: bypass the idempotency check and always run.
  // Set POPULATE_ALL_FORCE=1 (via `npm run experiment:force`) to activate.
  const forceRun = isForceMode();

  // Parse trace-mode CLI flags:
  //   --trace-build    enables buildPopulatedFromAnswer verbose trace (expected-graph wiring)
  //   --trace-compare  enables smartCompare verbose trace (per-node pairing and back-edges)
  const traceBuild = process.argv.includes('--trace-build');
  const traceCompare = process.argv.includes('--trace-compare');

  fs.mkdirSync(reportsLocalDir, { recursive: true });

  // ---------------------------------------------------------------------------
  // Idempotency check — skip the whole run if results are already up-to-date.
  // ---------------------------------------------------------------------------
  const algorithmNames = algorithms.map((a) => a.name);
  const probeNames = consumerProbes.map((p) => p.name);
  const fingerprint = computeFingerprint(manifest, datasets, algorithmNames, probeNames);

  if (!forceRun && isAlreadyUpToDate(reportsLocalDir, fingerprint, datasets)) {
    console.log(`⚡ Experiment results are already up-to-date — skipping run.`);
    console.log(`   (Run \`npm run experiment:force\` to re-run the experiment regardless.)`);
    return;
  }

  const runStartedAt = new Date();
  const runId = makeRunId(runStartedAt, projectRoot);
  const currentRunDir = path.join(reportsLocalDir, runId);
  fs.mkdirSync(currentRunDir, { recursive: true });

  // ---------------------------------------------------------------------------
  // Build run metadata (written into every report and the experiment index).
  // ---------------------------------------------------------------------------
  const runAt = runStartedAt.toISOString();
  const runMetadata: RunMetadata = {
    fingerprint,
    runAt,
    nodeVersion: process.version,
    platform: process.platform,
    packageVersion: pkgJson.version,
    datasets,
    algorithms: algorithmNames,
    probes: probeNames,
    manifestGeneratedAt: manifest.generatedAt,
  };

  // ---------------------------------------------------------------------------
  // Print one-time note about output scope.
  // ---------------------------------------------------------------------------
  // Determine which datasets get full-detail display vs. compact later-dataset format.
  // Full-detail: all datasets up to and including the cyclic baseline (e.g. acyclic-control + basic).
  // Compact later-dataset: all datasets after the cyclic baseline (e.g. medium, stress, extreme).
  //
  // Note: per-dataset processing uses `cyclicBaselineEstablished` to make the same
  // determination dynamically (see the `isFullDetailDataset` variable inside the loop).
  // Both mechanisms anchor to CYCLIC_BASELINE_TIER and must stay consistent.
  const cyclicBaselineIdx = datasets.indexOf(CYCLIC_BASELINE_TIER);
  const fullDetailDatasets = cyclicBaselineIdx >= 0 ? datasets.slice(0, cyclicBaselineIdx + 1) : datasets;
  const laterCyclicDatasets = cyclicBaselineIdx >= 0 ? datasets.slice(cyclicBaselineIdx + 1) : [];
  if (fullDetailDatasets.length > 0) {
    const names = fullDetailDatasets.join(' and ');
    console.log(`\nNote: Full experiment detail is shown for the ${names} dataset${fullDetailDatasets.length > 1 ? 's' : ''}.`);
    if (laterCyclicDatasets.length > 0) {
      console.log(`      Later datasets report only full experiment timing and meaningful outcome changes.`);
    }
    console.log('');
  }

  // Per-algorithm baseline fingerprints for consumer probes.
  // Set from the cyclic baseline tier (basic) — used to detect probe-outcome changes
  // on subsequent cyclic datasets.  NOT set from acyclic-control, because probe
  // results differ fundamentally between acyclic and cyclic graphs (e.g. naive-json
  // passes on acyclic graphs but is expected to fail on cyclic ones).
  const probeBaseline = new Map<string, string>();
  const baselineHydration = new Map<string, BenchmarkReport['hydration']>(); // algorithmName -> full hydration result
  // Whether the cyclic baseline (basic) has been fully processed.
  let cyclicBaselineEstablished = false;

  // Algorithms that failed at the cyclic baseline (basic) dataset.
  // These are skipped on subsequent cyclic datasets: if an algorithm fails on the smallest
  // cyclic dataset, larger datasets will also fail — re-executing adds no new information.
  // (Map Tracker passes at small scale and only fails at large scale, so it is NOT skipped.)
  const baselineFailedAlgorithms = new Set<string>();

  // Tracks algorithms whose first failure has been fully printed.
  // Maps algorithmName → failure fingerprint at time of first print.
  // Later datasets suppress repeats of the same failure (knownPriorFailure).
  // If the fingerprint differs, the new failure is treated as a fresh divergence.
  const documentedFailures = new Map<string, string>();

  // Summary data collected for the final table.
  const summaryRows: { algoName: string; results: Map<string, boolean | null> }[] = algorithms.map((a) => ({
    algoName: `[${a.category}] ${a.name}`,
    results: new Map(),
  }));

  // Consumer probe summary: compact per-algorithm per-dataset probe results.
  // Values: probe outcome icons like "✅/✅" or "❌/✅", "—" (not run),
  // "(skip)" (skipped after failing the cyclic baseline), or "⚠️" (conflict).
  const probeSummaryRows: { algoName: string; results: Map<string, string> }[] = algorithms.map((a) => ({
    algoName: `[${a.category}] ${a.name}`,
    results: new Map(),
  }));

  // Per-probe pass/fail keyed by probe name, for accurate name-based lookup in the summary.
  // Structure: algoIdx → dataset → probeName → boolean
  const probePassByName: Map<string, boolean>[][] = algorithms.map(() => []);

  // Track per-dataset report paths for the experiment index.
  const reportPaths: Record<string, string> = {};

  for (const dataset of datasets) {
    assertSafePathSegment(dataset, 'dataset');

    const inputEntry = manifest.files[`${dataset}${INPUT_SUFFIX}`];
    const answerEntry = manifest.files[`${dataset}${ANSWER_SUFFIX}`];

    // Skip datasets that don't have both input and answer files (e.g. disabled during generation)
    if (!inputEntry || !answerEntry) {
      console.log(`\n⏭️  Skipping dataset "${dataset}" — missing input or answer file in manifest.`);
      continue;
    }

    console.log(`--- ${dataset} dataset ---`);
    let inputData: ComponentFlat[];
    let rawAnswerEntries: AnswerEntry[];
    let answerData: ComponentPopulated[];
    try {
      inputData = parseInputData(loadYaml(inputEntry.filename), inputEntry.filename);
      rawAnswerEntries = parseAnswerData(loadYaml(answerEntry.filename), answerEntry.filename);
      if (traceBuild) {
        console.log(`\n=== buildPopulatedFromAnswer verbose trace — ${dataset} tier ===`);
      }
      answerData = buildPopulatedFromAnswer(rawAnswerEntries, traceBuild);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\n❌ Skipping dataset "${dataset}" — failed to load or validate data: ${msg}`);
      continue;
    }

    // -------------------------------------------------------------------------
    // Preflight validation — runs before any timed algorithm execution.
    // validateDataset checks structural integrity (duplicate IDs, duplicate
    // edges, dangling references), enforces unique auto-detected root semantics,
    // and verifies whole-graph reachability from that root. Only `core-valid`
    // datasets proceed to algorithm execution. This step has zero impact on
    // measured algorithm latency or memory — it is fixture-preparation only.
    // -------------------------------------------------------------------------
    const preflight = validateDataset(inputData);
    if (preflight.classification !== 'core-valid') {
      const isInvalid = preflight.classification === 'invalid';
      const icon = isInvalid ? '❌' : '⚠️';
      const reason = isInvalid ? 'preflight validation failed' : 'classified as edge-case-only (not a core benchmark dataset)';
      console.error(`\n${icon} Skipping dataset "${dataset}" — ${reason}:`);
      for (const msg of [...preflight.errors, ...preflight.warnings]) {
        console.error(`   • ${msg}`);
      }
      continue;
    }

    const datasetResults: BenchmarkReport[] = [];
    // True for any dataset at or before the cyclic baseline (acyclic-control and basic).
    // These receive the full-detail display format (all results printed immediately).
    // Datasets after the cyclic baseline (medium, stress, extreme) receive the compact
    // later-dataset format (deferred batch output, only meaningful changes reported).
    const isFullDetailDataset = !cyclicBaselineEstablished;
    // True only for the cyclic baseline tier (basic): anchors the skip/suppression logic.
    const isCyclicBaseline = dataset === CYCLIC_BASELINE_TIER;
    // For later datasets: collect per-algo outcomes for deferred batch formatting.
    const laterOutcomes: LaterAlgoOutcome[] = [];

    for (let algoIdx = 0; algoIdx < algorithms.length; algoIdx++) {
      const algo = algorithms[algoIdx];

      // Skip algorithms that failed on the cyclic baseline (basic) dataset — they
      // deterministically fail at all cyclic scales, so re-executing on larger datasets
      // adds no new information.  This skip applies only after the cyclic baseline is
      // established, so acyclic-control and basic always run every algorithm.
      // Map Tracker passes at small scale and only fails at large scale, so it continues running.
      if (!isFullDetailDataset && baselineFailedAlgorithms.has(algo.name)) {
        summaryRows[algoIdx].results.set(dataset, false);
        probeSummaryRows[algoIdx].results.set(dataset, '(skip)');
        // Re-use the exact hydration object from the baseline run.
        // metrics is null — no execution took place; skipped: true lets report
        // consumers distinguish these entries from genuine zero-time measurements.
        datasetResults.push({
          algorithmCategory: algo.category,
          algorithmName: algo.name,
          timeComplexity: algo.timeComplexity,
          spaceComplexity: algo.spaceComplexity,
          dataset: dataset,
          skipped: true,
          metrics: null,
          hydration: baselineHydration.get(algo.name)!,
          consumerProbes: { ran: false, probes: [] },
        });
        laterOutcomes.push({
          algoName: algo.name,
          algoCategory: algo.category,
          baselineSkipped: true,
          knownPriorFailure: false,
          isNewFailure: false,
          isConflict: false,
          probesFailed: false,
          hydrationLine: null,
          failureDetailLines: [],
          probeChangeLine: null,
        });
        continue;
      }

      // On full-detail datasets (acyclic-control, basic), print the algorithm header immediately.
      if (isFullDetailDataset) {
        console.log(`[${algo.category}] ${algo.name}`);
      }

      let smartResult = { pass: false, errorDetail: null as string | null, nodesProcessed: 0, edgesTraversed: 0 };
      let flatResult = { pass: false, errorDetail: null as string | null };
      let invariantResult: RuntimeHydrationInvariantResult = {
        pass: false,
        errorDetail: 'Invariant not evaluated',
        uniqueIds: 0,
        uniqueInstances: 0,
        edgesTraversed: 0,
      };
      let executionResult: ComponentPopulated[] | null = null;
      const expectedInvariantIndex = buildRuntimeHydrationExpectedIndex(rawAnswerEntries);

      // Start timing before algorithm execution.
      const startMem = process.memoryUsage().heapUsed;
      const startTime = performance.now();

      try {
        executionResult = algo.execute(inputData);

        if (traceCompare) {
          console.log(`\n=== smartCompare verbose trace — ${dataset} / ${algo.name} ===`);
        }
        const rawSmart = smartCompare(executionResult, answerData, traceCompare);
        const rawFlat = flatCompare(executionResult, rawAnswerEntries);
        const rawInvariant = rawSmart.pass && rawFlat.pass
          ? ('errorDetail' in expectedInvariantIndex
            ? {
                pass: false,
                errorDetail: expectedInvariantIndex.errorDetail,
                uniqueIds: expectedInvariantIndex.uniqueIds,
                uniqueInstances: 0,
                edgesTraversed: expectedInvariantIndex.edgesTraversed,
              }
            : runtimeHydrationInvariant(executionResult, rawAnswerEntries, expectedInvariantIndex))
          : { ...invariantResult, errorDetail: 'Invariant skipped (structural compare failed)' };
        // Cap error messages at MAX_ERROR_DETAIL_CHARS so display helpers never truncate.
        smartResult = { ...rawSmart, errorDetail: capErrorDetail(rawSmart.errorDetail) };
        flatResult = { ...rawFlat, errorDetail: capErrorDetail(rawFlat.errorDetail) };
        invariantResult = { ...rawInvariant, errorDetail: capErrorDetail(rawInvariant.errorDetail) };
      } catch (error: unknown) {
        const errorMessage = capErrorDetail(error instanceof Error ? error.message : String(error));
        const capped = errorMessage !== null && errorMessage !== '' ? errorMessage : 'Fatal Execution Error';
        smartResult = {
          pass: false,
          errorDetail: capped,
          nodesProcessed: 0,
          edgesTraversed: 0,
        };
        flatResult = {
          pass: false,
          errorDetail: capped,
        };
        invariantResult = {
          pass: false,
          errorDetail: capped,
          uniqueIds: 0,
          uniqueInstances: 0,
          edgesTraversed: 0,
        };
      }

      // Capture hydration-only time immediately after comparers complete.
      const hydrationEndTime = performance.now();
      const hydrationTimeMs = hydrationEndTime - startTime;

      const comparersPass = smartResult.pass && flatResult.pass;
      const bothPass = comparersPass && invariantResult.pass;
      const disagree = smartResult.pass !== flatResult.pass;

      const hydration: BenchmarkReport['hydration'] = {
        pass: bothPass,
        smartCompare: smartResult,
        flatCompare: flatResult,
        runtimeInvariant: invariantResult,
        doubleVerified: comparersPass,
      };

      // Stage 2 — Consumer probes: run only when hydration passed.
      // Reuses the execution result from Stage 1 — no second algorithm run.
      // Probes are defined in src/utils/consumer.ts.
      // Per-probe timing is captured so the headline can use hydration + fastest passing probe.
      const probeTimingsMs: Record<string, number> = {};
      let consumerProbeResult: BenchmarkReport['consumerProbes'];
      if (bothPass && executionResult !== null) {
        const captured = executionResult;
        const probeResults = consumerProbes.map((probe) => {
          const probeStart = performance.now();
          try {
            const r = probe.consume(captured);

            // If the probe produced a serialized output, verify its accuracy
            // against the known-correct raw answer entries from the manifest.
            let outputVerification: { pass: boolean; errorDetail: string | null } | null = null;
            if (r.pass && r.serializedOutput !== null) {
              outputVerification = compareAnswerEntries(r.serializedOutput, rawAnswerEntries);
            }

            // A probe's overall pass requires: (1) generation succeeded AND
            // (2) output accuracy check passed (if applicable).
            const overallPass = r.pass && (outputVerification === null || outputVerification.pass);
            const overallError = r.errorDetail ?? (outputVerification !== null && !outputVerification.pass ? outputVerification.errorDetail : null);

            probeTimingsMs[probe.name] = Number((performance.now() - probeStart).toFixed(3));
            return {
              name: probe.name,
              pass: overallPass,
              errorDetail: overallError,
              outputVerification,
            };
          } catch (error: unknown) {
            probeTimingsMs[probe.name] = Number((performance.now() - probeStart).toFixed(3));
            const errorMessage = error instanceof Error ? error.message : String(error);
            return {
              name: probe.name,
              pass: false,
              errorDetail: errorMessage !== '' ? errorMessage : `Probe '${probe.name}' encountered a fatal error`,
              outputVerification: null,
            };
          }
        });
        consumerProbeResult = { ran: true, probes: probeResults };
      } else {
        consumerProbeResult = { ran: false, probes: [] };
      }

      // Capture total RAM after all probes — used as the headline RAM for passes.
      const endMem = process.memoryUsage().heapUsed;
      const headlineRamMb = Math.max(0, (endMem - startMem) / 1024 / 1024);

      // End-to-end pass: hydration must succeed AND the cycle-aware consumer
      // (cycle-flat) must pass.  naive-json failure is expected for cyclic graphs
      // and does not affect the summary result.
      const cycleFlatResult = consumerProbeResult.ran ? consumerProbeResult.probes.find((p) => p.name === 'cycle-flat') : undefined;
      const endToEndPass = bothPass && (cycleFlatResult?.pass ?? false);

      // Headline time: hydration + fastest authoritative passing probe.
      // Only meaningful when the full experiment passed (endToEndPass).
      const passingProbeTimingsMs: number[] = [];
      if (consumerProbeResult.ran) {
        for (const probe of consumerProbeResult.probes) {
          if (probe.pass) {
            passingProbeTimingsMs.push(probeTimingsMs[probe.name] ?? 0);
          }
        }
      }
      const fastestProbeMs = passingProbeTimingsMs.length > 0 ? Math.min(...passingProbeTimingsMs) : 0;
      const headlineTimeMs = hydrationTimeMs + fastestProbeMs;

      // Record end-to-end result for the summary table.
      summaryRows[algoIdx].results.set(dataset, disagree ? null : endToEndPass);

      // Record consumer probe result for the probe summary table.
      if (!consumerProbeResult.ran) {
        probeSummaryRows[algoIdx].results.set(dataset, disagree ? '⚠️' : '—');
      } else {
        const iconStr = consumerProbeResult.probes.map((p) => (p.pass ? '✅' : '❌')).join('/');
        probeSummaryRows[algoIdx].results.set(dataset, iconStr);
        // Also record per-probe-name pass/fail for the end-of-run narrative summary.
        const namedResults = new Map(consumerProbeResult.probes.map((p) => [p.name, p.pass]));
        probePassByName[algoIdx].push(namedResults);
      }

      const report: BenchmarkReport = {
        algorithmCategory: algo.category,
        algorithmName: algo.name,
        timeComplexity: algo.timeComplexity,
        spaceComplexity: algo.spaceComplexity,
        dataset: dataset,
        metrics: {
          headlineTimeMs: endToEndPass ? Number(headlineTimeMs.toFixed(3)) : null,
          headlineRamMb: endToEndPass ? Number(headlineRamMb.toFixed(3)) : null,
          hydrationTimeMs: Number(hydrationTimeMs.toFixed(3)),
          probeTimingsMs,
        },
        hydration,
        consumerProbes: consumerProbeResult,
      };

      datasetResults.push(report);

      // -----------------------------------------------------------------------
      // Build formatted output lines (used for both immediate and deferred print)
      // -----------------------------------------------------------------------

      // Hydration result text — uses de-duplicating / classifying helper for failures.
      // classifyHydrationFailTag replaces raw comparer messages with clean developer-
      // friendly phrases for non-stack-overflow errors (e.g. identity mismatches).
      let resultLine: string;
      const smartErr = !smartResult.pass ? smartResult.errorDetail : null;
      const flatErr = !flatResult.pass ? flatResult.errorDetail : null;
      if (disagree) {
        resultLine = `🚨 CONFLICT — smartCompare=${smartResult.pass ? 'PASS' : 'FAIL'}, flatCompare=${flatResult.pass ? 'PASS' : 'FAIL'}`;
      } else if (bothPass) {
        // HYDRATION PASS intentionally remains a single label in runtime output.
        // Internally this still requires smartCompare + flatCompare + runtime invariant.
        resultLine = `✅ PASS`;
      } else if (comparersPass && !invariantResult.pass) {
        resultLine = `❌ FAIL [runtime invariant: ${invariantResult.errorDetail ?? 'failed'}]`;
      } else {
        resultLine = `❌ FAIL ${classifyHydrationFailTag(smartErr, flatErr)}`;
      }

      // Build the compact hydration/run line used for later-dataset (compact) format.
      // The full-detail format uses the three-line contract below instead.
      const hydrationLine = buildFullRunLine(bothPass, endToEndPass, resultLine, headlineTimeMs, headlineRamMb);

      // Build probe fingerprint for change-detection against baseline.
      // Use the literal 'SKIPPED' when hydration failed and probes did not run.
      const probeFingerprint: string = consumerProbeResult.ran
        ? consumerProbeResult.probes
            .map((p) => {
              const verifyTag = p.outputVerification !== null ? (p.outputVerification.pass ? '+ok' : '+fail') : '';
              return `${p.name}:${p.pass ? 'pass' : 'fail'}${verifyTag}`;
            })
            .join(',')
        : 'SKIPPED';

      // Build the probe summary string for both full-detail and consumer probe summary table.
      const probeSummaryStr = consumerProbeResult.ran
        ? consumerProbeResult.probes
            .map((p) => {
              const probeIcon = p.pass ? '✅' : '❌';
              const verifyIcon = p.outputVerification !== null ? (p.outputVerification.pass ? ' (output ✅)' : ' (output ❌)') : '';
              return `${probeIcon} ${p.name}${verifyIcon}`;
            })
            .join('  ')
        : '';

      if (isFullDetailDataset) {
        // ── Full-detail datasets (acyclic-control, basic): three-line phase contract ──
        // Normalize the raw run result into a typed state, then render all three lines.
        const phaseState = normalizeFullDetailPhaseState(
          bothPass,
          disagree,
          endToEndPass,
          consumerProbeResult.ran,
          resultLine,
          probeSummaryStr,
          headlineTimeMs,
          headlineRamMb
        );
        const [phaseHydrationLine, phaseProbesLine, phaseFullRunLine] = renderFullDetailLines(phaseState);
        console.log(phaseHydrationLine);
        console.log(phaseProbesLine);
        console.log(phaseFullRunLine);

        // Cyclic-baseline specific tracking: only basic anchors skip/suppression/probe-baseline.
        if (isCyclicBaseline) {
          // Record probe results as the reference baseline for later cyclic datasets.
          probeBaseline.set(algo.name, probeFingerprint);
          // Track failures at the cyclic baseline for skipping on later cyclic datasets.
          if (!bothPass && !disagree) {
            baselineHydration.set(algo.name, hydration);
            baselineFailedAlgorithms.add(algo.name);
            const failFingerprint = `smart:${(smartResult.errorDetail ?? '').substring(0, 80)}|flat:${(flatResult.errorDetail ?? '').substring(0, 80)}`;
            documentedFailures.set(algo.name, failFingerprint);
          }
        }
      } else {
        // ── Later dataset: collect outcome for deferred batch formatting ──────
        const failFingerprint =
          !bothPass && !disagree ? `smart:${(smartResult.errorDetail ?? '').substring(0, 80)}|flat:${(flatResult.errorDetail ?? '').substring(0, 80)}` : null;

        // Determine whether this failure is already documented from a prior tier.
        const knownPrior = failFingerprint !== null && documentedFailures.get(algo.name) === failFingerprint;
        const isNewFail = failFingerprint !== null && !knownPrior;

        if (isNewFail) {
          // First occurrence of this failure — document it so subsequent tiers suppress it.
          documentedFailures.set(algo.name, failFingerprint!);
        }

        // hydrationLine already encodes the correct label:
        //  - pass (endToEndPass):  "  Full Run:      ✅ PASS | Time: ... | RAM: ..."
        //  - hydration pass only:  "  Hydration:     ✅ PASS"  (authoritative probe failed)
        //  - fail:                 "  Hydration:     ❌ FAIL [...]"
        // For the later-tier outcome we use hydrationLine directly; it is only displayed
        // by buildLaterDatasetLines when probesFailed is false.
        const laterHydrationLine = hydrationLine;

        // probesFailed reflects the authoritative consumer (cycle-flat) — not naive-json.
        // naive-json failures are expected on cyclic graphs and are informational only;
        // they must not force the "Hydration: ✅ PASS" two-line format for later tiers.
        const probesFailed = consumerProbeResult.ran && !(cycleFlatResult?.pass ?? false);

        // Build the probe result/change line.
        //  - Always emit when probes failed (so the failure detail is never silently dropped,
        //    even when the probe fingerprint matches baseline).
        //  - Also emit when the probe fingerprint changed but all probes still passed.
        let probeChangeLine: string | null = null;
        const baselineProbe = probeBaseline.get(algo.name);
        const probeFingerprightChanged = baselineProbe !== undefined && baselineProbe !== probeFingerprint;
        if (consumerProbeResult.ran && (probesFailed || probeFingerprightChanged)) {
          const probeSummary = consumerProbeResult.probes
            .map((p) => {
              const probeIcon = p.pass ? '✅' : '❌';
              const verifyIcon = p.outputVerification !== null ? (p.outputVerification.pass ? ' (output ✅)' : ' (output ❌)') : '';
              return `${probeIcon} ${p.name}${verifyIcon}`;
            })
            .join('  ');
          // Use a fail label when probes actually failed; a change label otherwise.
          probeChangeLine = probesFailed ? `  Consumer probes: ❌ FAIL — ${probeSummary}` : `  Consumer probes: ⚠️  changed from baseline — ${probeSummary}`;
        }

        laterOutcomes.push({
          algoName: algo.name,
          algoCategory: algo.category,
          baselineSkipped: false,
          knownPriorFailure: knownPrior,
          isNewFailure: isNewFail,
          isConflict: disagree,
          probesFailed,
          hydrationLine: laterHydrationLine,
          // Failure detail lines are omitted — the error is already inline in
          // hydrationLine via the fail tag, so printing them separately would
          // duplicate the same message.
          failureDetailLines: [],
          probeChangeLine,
        });
      }
    }

    // Print the consolidated later-dataset output after all algorithms have run.
    if (!isFullDetailDataset) {
      const lines = buildLaterDatasetLines(laterOutcomes);
      for (const line of lines) console.log(line);
    }

    // After the cyclic baseline (basic) is fully processed, lock it in so that
    // subsequent datasets switch to the compact later-dataset format and can use
    // the skip/suppression/probe-baseline data established here.
    if (isCyclicBaseline) {
      cyclicBaselineEstablished = true;
    }

    // Write per-dataset report (wrapped with run metadata).
    // Write first, then clean up stale benchmark files so the new report is always
    // on disk before any older files are removed (avoids an empty directory on write failure).
    const datasetReportsDir = path.join(currentRunDir, dataset);
    fs.mkdirSync(datasetReportsDir, { recursive: true });
    const reportFilename = `benchmark-${Date.now()}.json`;
    const reportPath = path.join(datasetReportsDir, reportFilename);
    const datasetReportFile: DatasetReportFile = { metadata: runMetadata, results: datasetResults };
    fs.writeFileSync(reportPath, JSON.stringify(datasetReportFile, null, 2));
    cleanDatasetReports(datasetReportsDir, reportFilename);
    reportPaths[dataset] = `${dataset}/${reportFilename}`;
    console.log(`\n✅ Report saved to ${reportPath}\n`);
  }

  // ---------------------------------------------------------------------------
  // Write experiment-run.json index (enables skip check on next invocation).
  // ---------------------------------------------------------------------------
  const experimentIndex: ExperimentIndex = {
    metadata: runMetadata,
    reports: reportPaths,
  };
  fs.writeFileSync(path.join(currentRunDir, 'experiment-run.json'), JSON.stringify(experimentIndex, null, 2));

  // ---------------------------------------------------------------------------
  // Post-run summary table
  // ---------------------------------------------------------------------------
  const processedDatasets = datasets.filter((d) => summaryRows.some((r) => r.results.has(d)));

  if (processedDatasets.length > 0) {
    // ── Column widths — computed once, shared by both summary tables ─────────
    // COL_WIDTH: the wider of the minimum display width (10, needed for
    // "⚠️ CONFLICT") and the longest dataset name plus padding.  Applying the
    // same value to both the Run Summary and Consumer Probe Summary tables
    // keeps them aligned even with long names like "acyclic-control".
    const COL_WIDTH = Math.max(10, ...processedDatasets.map((d) => d.length + 2));
    const algoColWidth = Math.max(...summaryRows.map((r) => r.algoName.length)) + 2;

    const header = `Algorithm`.padEnd(algoColWidth) + processedDatasets.map((d) => d.padStart(COL_WIDTH)).join('');
    const divider = '─'.repeat(algoColWidth + COL_WIDTH * processedDatasets.length);

    console.log(`=== Run Summary ===`);
    console.log(header);
    console.log(divider);

    for (const row of summaryRows) {
      const cols = processedDatasets.map((d) => {
        const result = row.results.get(d);
        if (result === undefined) return '  —  '.padStart(COL_WIDTH);
        if (result === null) return '⚠️ CONFLICT'.padStart(COL_WIDTH);
        return (result ? '✅ PASS' : '❌ FAIL').padStart(COL_WIDTH);
      });
      console.log(row.algoName.padEnd(algoColWidth) + cols.join(''));
    }

    // ── Consumer Probe Summary (concise — Option C) ────────────────────────
    // Short narrative capturing the essential probe pattern.
    // Full per-algorithm probe detail was already shown inline during the run.

    console.log('');
    console.log(`=== Consumer Probe Summary ===`);
    console.log('');

    const stripCategory = (algoName: string) => algoName.replace(/^\[[^\]]+\] /, '');

    // All per-probe named results across all algorithms, flattened into a single array.
    // Each entry is a Map<probeName, boolean> from one algorithm×dataset run.
    const allNamedResults: Map<string, boolean>[] = probePassByName.flat();
    const anyProbeRan = allNamedResults.length > 0;

    // Algorithms where consumer probes never ran on any dataset.
    // "—" = probes skipped because hydration failed (or comparers conflicted).
    // "(skip)" = algorithm suppressed at this tier after failing the cyclic baseline.
    const alwaysNoProbe = probeSummaryRows.filter((r) =>
      processedDatasets.every((d) => {
        const v = r.results.get(d) ?? '—';
        return v === '—' || v === '(skip)';
      })
    );
    if (alwaysNoProbe.length > 0) {
      const shortNames = alwaysNoProbe.map((r) => stripCategory(r.algoName)).join(', ');
      console.log(`  • ${shortNames}: consumer probes never ran (hydration failed or algorithm suppressed).`);
    }

    if (anyProbeRan) {
      // naive-json: passes on acyclic graphs (no circular references), fails on cyclic ones.
      const naiveJsonPassedSome = allNamedResults.some((m) => m.get('naive-json') === true);
      const naiveJsonFailedSome = allNamedResults.some((m) => m.get('naive-json') === false);
      if (naiveJsonPassedSome || naiveJsonFailedSome) {
        const parts: string[] = [];
        if (naiveJsonPassedSome) parts.push('passes on acyclic-control (no cycles)');
        if (naiveJsonFailedSome) parts.push('fails on cyclic datasets where hydration succeeds');
        console.log(`  • naive-json: ${parts.join('; ')}.`);
      }

      // cycle-flat: authoritative — verify it passed on ALL runs where probes ran.
      const cycleFlatPassedAll = allNamedResults.every((m) => m.get('cycle-flat') === true);
      if (cycleFlatPassedAll) {
        console.log(`  • cycle-flat (authoritative): passes on every dataset where hydration succeeds.`);
      } else {
        // Surface any unexpected cycle-flat failure.
        console.log(`  • cycle-flat (authoritative): ⚠️  failed on at least one dataset — review inline output above.`);
      }
    }

    // Hydration failures always skip consumer probes.
    const hasHydrationFailures = probeSummaryRows.some((r) => processedDatasets.some((d) => r.results.get(d) === '—'));
    if (hasHydrationFailures) {
      console.log(`  • Hydration failures skip consumer probes entirely.`);
    }
  }
}

// Execute only when invoked directly; not when imported by tests or other modules.
if (require.main === module) {
  runBenchmark();
}
