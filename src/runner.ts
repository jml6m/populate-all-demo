import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { naiveRecursion } from './algorithms/cycle-detection/01-naive-recursion';
import { customMapTracker } from './algorithms/cycle-detection/02-custom-map-tracker';
import { dataloaderBatching } from './algorithms/graphql/01-dataloader-batching';
import { tarjanSccLayering } from './algorithms/topological/01-tarjan-scc-layering';
import { ComponentFlat, PopulateAlgorithm } from './algorithms/types';
import { smartCompare } from './utils/compare';

const algorithms: PopulateAlgorithm[] = [naiveRecursion, customMapTracker, tarjanSccLayering, dataloaderBatching];

const TEST_SUFFIX = '_test';
const ANSWER_SUFFIX = '_answer';

interface ManifestEntry {
  filename: string;
  contentHash: string;
}

interface Manifest {
  generatedAt: string;
  scriptHash: string;
  files: Record<string, ManifestEntry | undefined>;
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
  accuracy: {
    pass: boolean;
    errorDetail: string | null;
    nodesProcessed: number;
    edgesTraversed: number;
  };
}

function getDataDir(): string {
  const defaultDir = path.resolve(__dirname, '../data');
  const configPath = path.resolve(__dirname, 'generate-config.json');

  try {
    const rawConfig = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(rawConfig) as { outputDir?: unknown };
    if (typeof parsed.outputDir === 'string' && parsed.outputDir.trim() !== '') {
      return path.resolve(__dirname, parsed.outputDir);
    }
  } catch (err) {
    console.warn(
      `[runner] Could not read generate-config.json at "${configPath}"; falling back to default data dir. (${err instanceof Error ? err.message : String(err)})`
    );
  }

  return defaultDir;
}

function loadManifest(): Manifest {
  const dataDir = getDataDir();
  const manifestPath = path.resolve(dataDir, 'manifest.json');
  const raw = fs.readFileSync(manifestPath, 'utf8');
  return JSON.parse(raw) as Manifest;
}

function loadYaml(filename: string): unknown {
  const dataDir = getDataDir();
  const filePath = path.resolve(dataDir, filename);
  // Guard against path traversal: the relative path from dataDir must not escape
  // upward (i.e. start with '..') and must not be absolute.
  const relative = path.relative(dataDir, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path "${filePath}" is outside the data directory`);
  }
  const fileContent = fs.readFileSync(filePath, 'utf8');

  // Validate content hash embedded in filename against the actual file content
  const basename = path.basename(filename, '.yaml');
  const parts = basename.split('.');
  if (parts.length !== 3) {
    throw new Error(`Invalid benchmark filename "${filename}": expected "<name>.<type>.<hash>.yaml" format.`);
  }
  const embeddedContentHash = parts[2];
  const actualHash = crypto.createHash('sha256').update(fileContent).digest('hex').slice(0, 8);
  if (actualHash !== embeddedContentHash) {
    throw new Error(`Content hash mismatch for "${filename}": expected ${embeddedContentHash}, got ${actualHash}. File may have been tampered with.`);
  }

  // Disabling maxAliasCount (using hashes to verify files instead)
  return YAML.parse(fileContent, { maxAliasCount: -1 });
}

function runBenchmark() {
  const manifest = loadManifest();
  const scriptHash = manifest.scriptHash;
  const reportsDir = path.join(__dirname, '../reports');
  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir);
  }

  // Derive dataset names from manifest keys (e.g. "basic_test" -> "basic")
  const datasets = [
    ...new Set(
      Object.keys(manifest.files)
        .filter((key) => key.endsWith(TEST_SUFFIX))
        .map((key) => key.slice(0, -TEST_SUFFIX.length))
    ),
  ];

  for (const dataset of datasets) {
    // Idempotency guard: skip if a report already exists for this dataset + scriptHash
    const datasetReportsDir = path.join(reportsDir, dataset, scriptHash);
    if (fs.existsSync(datasetReportsDir)) {
      const existingReports = fs.readdirSync(datasetReportsDir).filter((f) => f.startsWith('benchmark-') && f.endsWith('.json'));
      if (existingReports.length > 0) {
        console.log(`\n⚡ Benchmark results already exist for dataset "${dataset}" with scriptHash=${scriptHash} — skipping.`);
        console.log(`   (Delete reports/${dataset}/${scriptHash}/ to force a re-run.)`);
        continue;
      }
    }

    console.log(`\n--- Loading ${dataset} dataset ---`);
    const testEntry = manifest.files[`${dataset}${TEST_SUFFIX}`];
    const answerEntry = manifest.files[`${dataset}${ANSWER_SUFFIX}`];
    if (!testEntry || !answerEntry) {
      throw new Error(`Missing manifest entries for dataset "${dataset}"`);
    }
    // Type casting the flat data for the algorithms
    const testData = loadYaml(testEntry.filename) as ComponentFlat[];
    const answerData = loadYaml(answerEntry.filename);

    const datasetReports: BenchmarkReport[] = [];

    for (const algo of algorithms) {
      console.log(`Running:[${algo.category}] ${algo.name}...`);

      let executionTimeMs = 0;
      let ramUsedMb = 0;
      let accuracyResult = { pass: false, errorDetail: null as string | null, nodesProcessed: 0, edgesTraversed: 0 };

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
          edgesTraversed: 0,
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

      datasetReports.push(report);

      console.log(`  Result: ${accuracyResult.pass ? '✅ PASS' : '❌ FAIL'} | Time: ${report.metrics.timeMs}ms | RAM: ${report.metrics.ramMb}MB`);

      // Strict boolean expression check
      if (accuracyResult.pass === false) {
        const previewError = (accuracyResult.errorDetail ?? '').substring(0, 100).replace(/\n/g, ' ');
        console.log(`  Error Detail: ${previewError}...`);
      }
    }

    // Write per-dataset report immediately after all algorithms finish for this dataset
    fs.mkdirSync(datasetReportsDir, { recursive: true });
    const reportPath = path.join(datasetReportsDir, `benchmark-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(datasetReports, null, 2));
    console.log(`\n✅ Report saved to ${reportPath}`);
  }
}

runBenchmark();
