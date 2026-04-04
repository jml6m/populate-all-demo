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

const algorithms: PopulateAlgorithm[] = [naiveRecursion, mapTracker, tarjanSccLayering, twoPassWire];

const INPUT_SUFFIX = '_input';
const ANSWER_SUFFIX = '_answer';

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
   * Stage 2 — Serialization: can the hydrated graph be consumed downstream?
   * Only runs when hydration passes.  Each probe tests a different consumer
   * strategy (see src/utils/consumer.ts for the ConsumerProbe abstraction).
   *
   * Key insight: hydration success ≠ serialization safety.  A correctly
   * hydrated cyclic graph still crashes naive consumers (e.g. JSON.stringify).
   * Only cycle-aware consumers (e.g. index-based export) handle it safely.
   *
   * Each probe is evaluated in two steps:
   *   1. Did it generate a valid output?  (pass / errorDetail)
   *   2. Is that output accurate?  (outputVerification — present when the probe
   *      produced a serializedOutput that was compared against rawAnswerEntries)
   */
  serialization: {
    /** false when hydration failed — serialization probes are skipped. */
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

function runBenchmark() {
  const manifest = loadManifest();
  const reportsDir = path.join(__dirname, '../reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir);
  }

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

  // Parse trace-mode CLI flags:
  //   --trace-build    enables buildPopulatedFromAnswer verbose trace (expected-graph wiring)
  //   --trace-compare  enables smartCompare verbose trace (per-node pairing and back-edges)
  const traceBuild = process.argv.includes('--trace-build');
  const traceCompare = process.argv.includes('--trace-compare');

  for (const dataset of datasets) {
    assertSafePathSegment(dataset, 'dataset');

    const inputEntry = manifest.files[`${dataset}${INPUT_SUFFIX}`];
    const answerEntry = manifest.files[`${dataset}${ANSWER_SUFFIX}`];

    // Skip datasets that don't have both input and answer files (e.g. disabled during generation)
    if (!inputEntry || !answerEntry) {
      console.log(`\n⏭️  Skipping dataset "${dataset}" — missing input or answer file in manifest.`);
      continue;
    }

    console.log(`\n--- Loading ${dataset} dataset ---`);
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

    const datasetReports: BenchmarkReport[] = [];

    for (const algo of algorithms) {
      console.log(`Running:[${algo.category}] ${algo.name}...`);

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

      // Stage 2 — Serialization: run consumer probes only when hydration passed.
      // Reuses the execution result from Stage 1 — no second algorithm run.
      // Probes are defined in src/utils/consumer.ts.
      let serialization: BenchmarkReport['serialization'];
      if (bothPass && executionResult !== null) {
        const captured = executionResult;
        const probeResults = consumerProbes.map((probe) => {
          try {
            const r = probe.consume(captured);

            // Step 2: if the probe produced a serialized output, verify its accuracy
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
        serialization = { ran: true, probes: probeResults };
      } else {
        serialization = { ran: false, probes: [] };
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
        serialization,
      };

      datasetReports.push(report);

      let resultLine: string;
      if (disagree) {
        resultLine = `🚨 VERIFICATION CONFLICT — smartCompare=${smartResult.pass ? 'PASS' : 'FAIL'}, flatCompare=${flatResult.pass ? 'PASS' : 'FAIL'}`;
      } else if (bothPass) {
        resultLine = `✅ PASS (double-verified)`;
      } else {
        const smartErr = smartResult.errorDetail !== null ? `smartCompare: ${smartResult.errorDetail.substring(0, 60)}` : '';
        const flatErr = flatResult.errorDetail !== null ? `flatCompare: ${flatResult.errorDetail.substring(0, 60)}` : '';
        resultLine = `❌ FAIL [${smartErr}] [${flatErr}]`;
      }

      console.log(`  Hydration:     ${resultLine} | Time: ${formatTime(report.metrics.timeMs)} | RAM: ${formatRam(report.metrics.ramMb)}`);

      if (!bothPass && !disagree) {
        if (!smartResult.pass && smartResult.errorDetail !== null) {
          const previewError = smartResult.errorDetail.substring(0, 100).replace(/\n/g, ' ');
          console.log(`  smartCompare Error: ${previewError}...`);
        }
        if (!flatResult.pass && flatResult.errorDetail !== null) {
          const previewError = flatResult.errorDetail.substring(0, 100).replace(/\n/g, ' ');
          console.log(`  flatCompare Error: ${previewError}...`);
        }
      }

      if (serialization.ran) {
        const probeSummary = serialization.probes
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
        console.log(`  Serialization: ${probeSummary}`);
      } else {
        console.log(`  Serialization: ⏭️  skipped (hydration failed)`);
      }
    }

    // Write per-dataset report
    const datasetReportsDir = path.join(reportsDir, dataset);
    fs.mkdirSync(datasetReportsDir, { recursive: true });
    const reportPath = path.join(datasetReportsDir, `benchmark-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(datasetReports, null, 2));
    console.log(`\n✅ Report saved to ${reportPath}`);
  }
}

runBenchmark();
