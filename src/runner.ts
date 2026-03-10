import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { naiveRecursion } from './algorithms/cycle-detection/01-naive-recursion';
import { customMapTracker } from './algorithms/cycle-detection/02-custom-map-tracker';
import { ComponentFlat, PopulateAlgorithm } from './algorithms/types';
import { smartCompare } from './utils/compare';

const algorithms: PopulateAlgorithm[] = [naiveRecursion, customMapTracker];

const datasets = ['basic', 'stress'];

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
  accuracy: {
    pass: boolean;
    errorDetail: string | null;
    nodesProcessed: number;
  };
}

function loadYaml(filename: string): unknown {
  const dataDir = path.resolve(__dirname, '../data');
  const filePath = path.resolve(dataDir, filename);
  // Guard against path traversal: the relative path from dataDir must not escape
  // upward (i.e. start with '..') and must not be absolute.
  const relative = path.relative(dataDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path "${filePath}" is outside the data directory`);
  }
  const fileContent = fs.readFileSync(filePath, 'utf8');
  // maxAliasCount is raised from the default (100) because the stress dataset YAML
  // uses aliases extensively for its 1,000-node graph. Raising the limit is safe here
  // because: (1) filenames are derived from the hardcoded `datasets` array, not user
  // input; (2) the path-traversal guard above ensures we only read from the data
  // directory; (3) the files themselves are produced by our deterministic generate.ts.
  return YAML.parse(fileContent, { maxAliasCount: 10000 });
}

function runBenchmark() {
  const reports: BenchmarkReport[] = [];
  const reportsDir = path.join(__dirname, '../reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir);
  }

  for (const dataset of datasets) {
    console.log(`\n--- Loading ${dataset} dataset ---`);
    // Type casting the flat data for the algorithms
    const testData = loadYaml(`${dataset}_test.yaml`) as ComponentFlat[];
    const answerData = loadYaml(`${dataset}_answer.yaml`);

    for (const algo of algorithms) {
      console.log(`Running:[${algo.category}] ${algo.name}...`);

      let executionTimeMs = 0;
      let ramUsedMb = 0;
      let accuracyResult = { pass: false, errorDetail: null as string | null, nodesProcessed: 0 };

      try {
        const startMem = process.memoryUsage().heapUsed;
        const startTime = performance.now();

        const result = algo.execute(testData);

        const endTime = performance.now();
        const endMem = process.memoryUsage().heapUsed;

        executionTimeMs = endTime - startTime;
        ramUsedMb = Math.max(0, (endMem - startMem) / 1024 / 1024);

        accuracyResult = smartCompare(result, answerData);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        accuracyResult = {
          pass: false,
          errorDetail: errorMessage !== '' ? errorMessage : 'Fatal Execution Error',
          nodesProcessed: 0,
        };
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
        accuracy: accuracyResult,
      };

      reports.push(report);

      console.log(`  Result: ${accuracyResult.pass ? '✅ PASS' : '❌ FAIL'} | Time: ${report.metrics.timeMs}ms | RAM: ${report.metrics.ramMb}MB`);

      // Strict boolean expression check
      if (accuracyResult.pass === false) {
        const previewError = (accuracyResult.errorDetail ?? '').substring(0, 100).replace(/\n/g, ' ');
        console.log(`  Error Detail: ${previewError}...`);
      }
    }
  }

  const reportPath = path.join(reportsDir, `benchmark-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(reports, null, 2));
  console.log(`\n✅ Full report saved to ${reportPath}`);
}

runBenchmark();
