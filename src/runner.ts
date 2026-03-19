import fs from 'fs';
import path from 'path';
import { mapTracker } from './algorithms/reference-tracking/02-map-tracker';
import { naiveRecursion } from './algorithms/reference-tracking/01-naive-recursion';
import { twoPassWire } from './algorithms/schema-driven/01-two-pass-wire';
import { tarjanSccLayering } from './algorithms/topological/01-tarjan-scc-layering';
import { AnswerEntry, ComponentFlat, PopulateAlgorithm } from './algorithms/types';
import { buildPopulatedFromAnswer } from './utils/answer-builder';
import { smartCompare } from './utils/compare';
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
  verification: {
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
    const inputData = loadYaml(inputEntry.filename) as ComponentFlat[];
    // Keep raw entries for flatCompare (which verifies against the file directly)
    const rawAnswerEntries = loadYaml(answerEntry.filename) as AnswerEntry[];
    const answerData = buildPopulatedFromAnswer(rawAnswerEntries);

    const datasetReports: BenchmarkReport[] = [];

    for (const algo of algorithms) {
      console.log(`Running:[${algo.category}] ${algo.name}...`);

      let executionTimeMs = 0;
      let ramUsedMb = 0;
      let smartResult = { pass: false, errorDetail: null as string | null, nodesProcessed: 0, edgesTraversed: 0 };
      let flatResult = { pass: false, errorDetail: null as string | null };

      try {
        const startMem = process.memoryUsage().heapUsed;
        const startTime = performance.now();

        const result = algo.execute(inputData);

        const endTime = performance.now();
        const endMem = process.memoryUsage().heapUsed;

        executionTimeMs = endTime - startTime;
        ramUsedMb = Math.max(0, (endMem - startMem) / 1024 / 1024);

        smartResult = smartCompare(result, answerData);
        flatResult = flatCompare(result, rawAnswerEntries);
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

      const verification: BenchmarkReport['verification'] = {
        pass: bothPass,
        smartCompare: smartResult,
        flatCompare: flatResult,
        doubleVerified: bothPass,
      };

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
        verification,
      };

      datasetReports.push(report);

      // Build result line
      let resultLine: string;
      if (disagree) {
        if (smartResult.pass) {
          resultLine = '🚨 VERIFICATION CONFLICT — smartCompare=PASS, flatCompare=FAIL';
        } else {
          resultLine = '🚨 VERIFICATION CONFLICT — smartCompare=FAIL, flatCompare=PASS';
        }
      } else if (bothPass) {
        resultLine = '✅ PASS (double-verified)';
      } else {
        const errors: string[] = [];
        if (!smartResult.pass) errors.push(`smartCompare: ${smartResult.errorDetail ?? ''}`);
        if (!flatResult.pass) errors.push(`flatCompare: ${flatResult.errorDetail ?? ''}`);
        resultLine = `❌ FAIL [${errors.join('] [')}]`;
      }

      console.log(`  Result: ${resultLine} | Time: ${formatTime(report.metrics.timeMs)} | RAM: ${formatRam(report.metrics.ramMb)}`);

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
