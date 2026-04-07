import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { mapTracker } from './algorithms/reference-tracking/02-map-tracker';
import { naiveRecursion } from './algorithms/reference-tracking/01-naive-recursion';
import { twoPassWire } from './algorithms/schema-driven/01-two-pass-wire';
import { tarjanSccLayering } from './algorithms/topological/01-tarjan-scc-layering';
import { AnswerEntry, ComponentFlat, ComponentPopulated, PopulateAlgorithm } from './algorithms/types';
import { buildPopulatedFromAnswer } from './utils/answer-builder';
import { smartCompare } from './utils/compare';
import { consumerProbes } from './utils/consumer';
import { assertSafePathSegment, loadManifest, loadYaml } from './utils/data-loader';
import { flatCompare } from './utils/flat-compare';
import { Manifest } from './types';
import pkgJson from '../package.json';

const algorithms: PopulateAlgorithm[] = [naiveRecursion, mapTracker, tarjanSccLayering, twoPassWire];

const INPUT_SUFFIX = '_input';
const ANSWER_SUFFIX = '_answer';

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
 * `reports/experiment-run.json`.  Used by the next invocation to decide
 * whether to skip.
 */
export interface ExperimentIndex {
  metadata: RunMetadata;
  /** Per-dataset report paths, relative to the reports directory (e.g. "basic/benchmark-1234.json"). */
  reports: Record<string, string>;
}

interface BenchmarkReport {
  algorithmCategory: string;
  algorithmName: string;
  timeComplexity: string;
  spaceComplexity: string;
  dataset: string;
  metrics: {
    timeMs: number;
    ramMb: number;
  };
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
function compareAnswerEntries(
  generated: AnswerEntry[],
  expected: AnswerEntry[],
): { pass: boolean; errorDetail: string | null } {
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

// Time: sub-0.1ms is below timing noise floor; scale units at 1s and 60s.
function formatTime(ms: number): string {
  if (ms < 0.1) return '< 0.1ms';
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return '> 60s';
}

// RAM: sub-0.1 MB heap deltas are within measurement noise; scale to GB at 1024 MB.
function formatRam(mb: number): string {
  if (mb < 0.1) return '< 0.1 MB';
  if (mb < 10) return `${mb.toFixed(1)} MB`;
  if (mb < 1000) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
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
export function computeFingerprint(
  manifest: Manifest,
  datasets: string[],
  algorithmNames: string[],
  probeNames: string[],
): string {
  const relevantFileHashes = Object.fromEntries(
    Object.entries(manifest.files)
      .filter(([k]) => datasets.some((d) => k === `${d}${INPUT_SUFFIX}` || k === `${d}${ANSWER_SUFFIX}`))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, v?.contentHash ?? null]),
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

/**
 * Returns true when an existing experiment-run.json index matches the current
 * fingerprint AND every referenced per-dataset report file exists on disk.
 */
export function isAlreadyUpToDate(reportsDir: string, fingerprint: string, datasets: string[]): boolean {
  const indexPath = path.join(reportsDir, 'experiment-run.json');
  if (!fs.existsSync(indexPath)) return false;

  try {
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ExperimentIndex;
    if (index.metadata.fingerprint !== fingerprint) return false;

    for (const dataset of datasets) {
      const reportRelPath = index.reports[dataset];
      if (typeof reportRelPath !== 'string') return false;
      // Guard against path traversal: the resolved path must stay within reportsDir.
      const absPath = path.resolve(reportsDir, reportRelPath);
      const rel = path.relative(reportsDir, absPath);
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
 * Force mode is detected from two sources (in priority order):
 *   1. The `POPULATE_ALL_FORCE` environment variable set to `"1"` — used by the
 *      `npm run experiment:force` script, because npm intercepts `--force` before
 *      the Node process can see it.
 *   2. The `--force` CLI argument — works when the script is invoked directly
 *      (e.g. `tsx src/runner.ts --force`) without going through npm.
 */
export function isForceMode(): boolean {
  return process.env.POPULATE_ALL_FORCE === '1' || process.argv.includes('--force');
}

function runBenchmark() {
  const manifest = loadManifest();
  const reportsDir = path.join(__dirname, '../reports');

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

  // Parse --force CLI flag: bypass idempotency check and always run.
  // Also supported via the POPULATE_ALL_FORCE=1 environment variable for
  // npm-script invocations (npm intercepts --force before the Node process sees it).
  // Use `npm run experiment:force` for reliable force mode through npm.
  const forceRun = isForceMode();

  // Parse trace-mode CLI flags:
  //   --trace-build    enables buildPopulatedFromAnswer verbose trace (expected-graph wiring)
  //   --trace-compare  enables smartCompare verbose trace (per-node pairing and back-edges)
  const traceBuild = process.argv.includes('--trace-build');
  const traceCompare = process.argv.includes('--trace-compare');

  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir);
  }

  // ---------------------------------------------------------------------------
  // Idempotency check — skip the whole run if results are already up-to-date.
  // ---------------------------------------------------------------------------
  const algorithmNames = algorithms.map((a) => a.name);
  const probeNames = consumerProbes.map((p) => p.name);
  const fingerprint = computeFingerprint(manifest, datasets, algorithmNames, probeNames);

  if (!forceRun && isAlreadyUpToDate(reportsDir, fingerprint, datasets)) {
    console.log(`⚡ Experiment results are already up-to-date — skipping run.`);
    console.log(`   (Run \`npm run experiment:force\` to re-run the experiment regardless.)`);
    return;
  }

  // ---------------------------------------------------------------------------
  // Build run metadata (written into every report and the experiment index).
  // ---------------------------------------------------------------------------
  const runAt = new Date().toISOString();
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
  // Print one-time note about consumer probe output scope.
  // ---------------------------------------------------------------------------
  console.log(
    `\nNote: Consumer probe details are printed in full for the first (baseline) dataset only.`,
  );
  console.log(`      Later datasets focus on hydration scalability — probe results are scale-invariant.\n`);

  // Per-algorithm baseline fingerprints for hydration failures and consumer probes.
  // Used to suppress repeated identical detail lines on subsequent datasets.
  // Key: algorithmName, Value: fingerprint string.
  const probeBaseline = new Map<string, string>();
  const hydrationFailBaseline = new Map<string, string>(); // algorithmName -> fingerprint
  const hydrationErrorBaseline = new Map<string, string | null>(); // algorithmName -> error message (for reports)
  let baselineDataset: string | null = null;

  // Algorithms that failed at the baseline (first/smallest) dataset.
  // These are skipped on subsequent datasets: if an algorithm fails on the smallest
  // cyclic dataset, larger datasets will also fail — re-executing adds no new information.
  // (Map Tracker passes at small scale and only fails at large scale, so it is NOT skipped.)
  const baselineFailedAlgorithms = new Set<string>();

  // Summary data collected for the final table.
  const summaryRows: { algoName: string; results: Map<string, boolean | null> }[] = algorithms.map(
    (a) => ({ algoName: `[${a.category}] ${a.name}`, results: new Map() }),
  );

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

    const datasetResults: BenchmarkReport[] = [];

    for (let algoIdx = 0; algoIdx < algorithms.length; algoIdx++) {
      const algo = algorithms[algoIdx];

      // Skip algorithms that failed on the baseline dataset — they deterministically fail
      // at all scales, so re-executing on larger datasets adds no new information.
      // Map Tracker passes at small scale and only fails at large scale, so it continues running.
      if (baselineDataset !== null && baselineFailedAlgorithms.has(algo.name)) {
        console.log(`[${algo.category}] ${algo.name}`);
        console.log(`  Hydration:     ❌ FAIL (baseline)`);
        summaryRows[algoIdx].results.set(dataset, false);
        // Record a minimal report using the cached baseline failure detail.
        const failDetail = hydrationErrorBaseline.get(algo.name) ?? null;
        datasetResults.push({
          algorithmCategory: algo.category,
          algorithmName: algo.name,
          timeComplexity: algo.timeComplexity,
          spaceComplexity: algo.spaceComplexity,
          dataset: dataset,
          metrics: { timeMs: 0, ramMb: 0 },
          hydration: {
            pass: false,
            smartCompare: { pass: false, errorDetail: failDetail, nodesProcessed: 0, edgesTraversed: 0 },
            flatCompare: { pass: false, errorDetail: failDetail },
            doubleVerified: false,
          },
          consumerProbes: { ran: false, probes: [] },
        });
        continue;
      }

      console.log(`[${algo.category}] ${algo.name}`);

      let executionTimeMs = 0;
      let ramUsedMb = 0;
      let smartResult = { pass: false, errorDetail: null as string | null, nodesProcessed: 0, edgesTraversed: 0 };
      let flatResult = { pass: false, errorDetail: null as string | null };
      let executionResult: ComponentPopulated[] | null = null;

      try {
        const startMem = process.memoryUsage().heapUsed;
        const startTime = performance.now();

        executionResult = algo.execute(inputData);

        const endTime = performance.now();
        const endMem = process.memoryUsage().heapUsed;

        executionTimeMs = endTime - startTime;
        ramUsedMb = Math.max(0, (endMem - startMem) / 1024 / 1024);

        if (traceCompare) {
          console.log(`\n=== smartCompare verbose trace — ${dataset} / ${algo.name} ===`);
        }
        smartResult = smartCompare(executionResult, answerData, traceCompare);
        flatResult = flatCompare(executionResult, rawAnswerEntries);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        smartResult = {
          pass: false,
          errorDetail: errorMessage !== '' ? errorMessage : 'Fatal Execution Error',
          nodesProcessed: 0,
          edgesTraversed: 0,
        };
        flatResult = {
          pass: false,
          errorDetail: errorMessage !== '' ? errorMessage : 'Fatal Execution Error',
        };
      }

      const bothPass = smartResult.pass && flatResult.pass;
      const disagree = smartResult.pass !== flatResult.pass;

      const hydration: BenchmarkReport['hydration'] = {
        pass: bothPass,
        smartCompare: smartResult,
        flatCompare: flatResult,
        doubleVerified: bothPass,
      };

      // Record hydration result for the summary table.
      summaryRows[algoIdx].results.set(dataset, disagree ? null : bothPass);

      // Stage 2 — Consumer probes: run only when hydration passed.
      // Reuses the execution result from Stage 1 — no second algorithm run.
      // Probes are defined in src/utils/consumer.ts.
      let consumerProbeResult: BenchmarkReport['consumerProbes'];
      if (bothPass && executionResult !== null) {
        const captured = executionResult;
        const probeResults = consumerProbes.map((probe) => {
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
            const overallError =
              r.errorDetail ?? (outputVerification !== null && !outputVerification.pass ? outputVerification.errorDetail : null);

            return {
              name: probe.name,
              pass: overallPass,
              errorDetail: overallError,
              outputVerification,
            };
          } catch (error: unknown) {
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

      const report: BenchmarkReport = {
        algorithmCategory: algo.category,
        algorithmName: algo.name,
        timeComplexity: algo.timeComplexity,
        spaceComplexity: algo.spaceComplexity,
        dataset: dataset,
        metrics: {
          timeMs: Number(executionTimeMs.toFixed(3)),
          ramMb: Number(ramUsedMb.toFixed(3)),
        },
        hydration,
        consumerProbes: consumerProbeResult,
      };

      datasetResults.push(report);

      // -----------------------------------------------------------------------
      // Console output for this algorithm
      // -----------------------------------------------------------------------

      let resultLine: string;
      if (disagree) {
        resultLine = `🚨 CONFLICT — smartCompare=${smartResult.pass ? 'PASS' : 'FAIL'}, flatCompare=${flatResult.pass ? 'PASS' : 'FAIL'}`;
      } else if (bothPass) {
        resultLine = `✅ PASS (double-verified)`;
      } else {
        const smartErr = smartResult.errorDetail !== null ? `smartCompare: ${smartResult.errorDetail.substring(0, 60)}` : '';
        const flatErr = flatResult.errorDetail !== null ? `flatCompare: ${flatResult.errorDetail.substring(0, 60)}` : '';
        resultLine = `❌ FAIL [${smartErr}] [${flatErr}]`;
      }

      console.log(`  Hydration:     ${resultLine} | Time: ${formatTime(report.metrics.timeMs)} | RAM: ${formatRam(report.metrics.ramMb)}`);

      // Print error detail lines for failures.
      // On the baseline dataset: always print.
      // On subsequent datasets: only print when the failure is different from the baseline
      //   (same failure as baseline → suppress to keep output clean).
      if (!bothPass && !disagree) {
        const failFingerprint =
          `smart:${(smartResult.errorDetail ?? '').substring(0, 80)}|flat:${(flatResult.errorDetail ?? '').substring(0, 80)}`;

        const baselineFail = hydrationFailBaseline.get(algo.name);
        const isKnownFail = baselineDataset !== null && baselineFail === failFingerprint;

        if (!isKnownFail) {
          if (baselineDataset !== null && baselineFail !== undefined) {
            // Different failure from baseline — flag it clearly.
            console.log(`  ⚠️  Failure differs from baseline:`);
          }
          if (!smartResult.pass && smartResult.errorDetail !== null) {
            const previewError = smartResult.errorDetail.substring(0, 100).replace(/\n/g, ' ');
            console.log(`  smartCompare Error: ${previewError}...`);
          }
          if (!flatResult.pass && flatResult.errorDetail !== null) {
            const previewError = flatResult.errorDetail.substring(0, 100).replace(/\n/g, ' ');
            console.log(`  flatCompare Error: ${previewError}...`);
          }
        }

        if (baselineDataset === null) {
          hydrationFailBaseline.set(algo.name, failFingerprint);
          // Store both hydration error messages so baseline-skip reports can
          // accurately re-use the original smartCompare and flatCompare details.
          const baselineHydrationErrorDetail = JSON.stringify({
            smartErrorDetail: smartResult.errorDetail,
            flatErrorDetail: flatResult.errorDetail,
          });
          hydrationErrorBaseline.set(algo.name, baselineHydrationErrorDetail);
          // Mark this algorithm as a deterministic baseline failure so it will
          // be skipped (not re-executed) on all subsequent, larger datasets.
          baselineFailedAlgorithms.add(algo.name);
        }
      }

      // Build a probe fingerprint for change-detection against the baseline.
      // Use the literal 'SKIPPED' when hydration failed and probes did not run.
      const probeFingerprint: string = consumerProbeResult.ran
        ? consumerProbeResult.probes
            .map((p) => {
              const verifyTag =
                p.outputVerification !== null ? (p.outputVerification.pass ? '+ok' : '+fail') : '';
              return `${p.name}:${p.pass ? 'pass' : 'fail'}${verifyTag}`;
            })
            .join(',')
        : 'SKIPPED';

      if (baselineDataset === null) {
        // First (baseline) dataset — record probe baseline and print details in full.
        probeBaseline.set(algo.name, probeFingerprint);

        if (consumerProbeResult.ran) {
          const probeSummary = consumerProbeResult.probes
            .map((p) => {
              const probeIcon = p.pass ? '✅' : '❌';
              const verifyIcon =
                p.outputVerification !== null
                  ? p.outputVerification.pass
                    ? ' (output ✅)'
                    : ' (output ❌)'
                  : '';
              return `${probeIcon} ${p.name}${verifyIcon}`;
            })
            .join('  ');
          console.log(`  Consumer probes: ${probeSummary}`);
        } else {
          console.log(`  Consumer probes: not run (hydration failed)`);
        }
      } else {
        // Subsequent dataset — probe outcomes are omitted when unchanged from baseline.
        // When the result changed vs. baseline AND probes still ran (different outcome),
        // print in full so the divergence is visible.
        // When probes went from "ran" to "not run" due to hydration failure, that is
        // already communicated by the hydration output line above — no probe line needed.
        const baseline = probeBaseline.get(algo.name);
        if (baseline === undefined || baseline !== probeFingerprint) {
          if (consumerProbeResult.ran) {
            const probeSummary = consumerProbeResult.probes
              .map((p) => {
                const probeIcon = p.pass ? '✅' : '❌';
                const verifyIcon =
                  p.outputVerification !== null
                    ? p.outputVerification.pass
                      ? ' (output ✅)'
                      : ' (output ❌)'
                    : '';
                return `${probeIcon} ${p.name}${verifyIcon}`;
              })
              .join('  ');
            console.log(`  Consumer probes: ⚠️  changed from baseline — ${probeSummary}`);
          }
          // else: hydration failed — probes not run; already shown in the hydration line above.
        }
        // Unchanged from baseline: intentionally no output line.
      }
    }

    // After the first dataset's algorithms have been processed, lock in the baseline.
    if (baselineDataset === null) {
      baselineDataset = dataset;
    }

    // Write per-dataset report (wrapped with run metadata).
    const datasetReportsDir = path.join(reportsDir, dataset);
    fs.mkdirSync(datasetReportsDir, { recursive: true });
    const reportFilename = `benchmark-${Date.now()}.json`;
    const reportPath = path.join(datasetReportsDir, reportFilename);
    const datasetReportFile: DatasetReportFile = { metadata: runMetadata, results: datasetResults };
    fs.writeFileSync(reportPath, JSON.stringify(datasetReportFile, null, 2));
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
  fs.writeFileSync(
    path.join(reportsDir, 'experiment-run.json'),
    JSON.stringify(experimentIndex, null, 2),
  );

  // ---------------------------------------------------------------------------
  // Post-run summary table
  // ---------------------------------------------------------------------------
  const processedDatasets = datasets.filter((d) =>
    summaryRows.some((r) => r.results.has(d)),
  );

  if (processedDatasets.length > 0) {
    const COL_WIDTH = 10;
    const algoColWidth = Math.max(...summaryRows.map((r) => r.algoName.length)) + 2;

    const header =
      `Algorithm`.padEnd(algoColWidth) +
      processedDatasets.map((d) => d.padStart(COL_WIDTH)).join('');
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
  }
}

// Execute only when invoked directly; not when imported by tests or other modules.
if (require.main === module) {
  runBenchmark();
}
