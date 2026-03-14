import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { mapTracker } from './algorithms/reference-tracking/02-map-tracker';
import { naiveRecursion } from './algorithms/reference-tracking/01-naive-recursion';
import { twoPassWire } from './algorithms/schema-driven/01-two-pass-wire';
import { tarjanSccLayering } from './algorithms/topological/01-tarjan-scc-layering';
import { AnswerEntry, ComponentFlat, ComponentPopulated, PopulateAlgorithm } from './algorithms/types';
import { smartCompare } from './utils/compare';

const algorithms: PopulateAlgorithm[] = [naiveRecursion, mapTracker, tarjanSccLayering, twoPassWire];

const INPUT_SUFFIX = '_input';
const ANSWER_SUFFIX = '_answer';

interface ManifestEntry {
  filename: string;
  contentHash: string;
}

interface Manifest {
  generatedAt: string;
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

// Validates that a value is a safe single-segment path component (no slashes, dots-only names, or other traversal characters).
const SAFE_PATH_SEGMENT = /^[a-z0-9_-]+$/i;
function assertSafePathSegment(value: string, label: string): void {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Unsafe ${label} value "${value}": must match ${SAFE_PATH_SEGMENT.source}`);
  }
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
  if (parts.length !== 2) {
    throw new Error(`Invalid benchmark filename "${filename}": expected "<name>.<hash>.yaml" format.`);
  }
  const embeddedContentHash = parts[1];
  const actualHash = crypto.createHash('sha256').update(fileContent).digest('hex').slice(0, 8);
  if (actualHash !== embeddedContentHash) {
    throw new Error(`Content hash mismatch for "${filename}": expected ${embeddedContentHash}, got ${actualHash}. File may have been tampered with.`);
  }

  // Disabling maxAliasCount (using hashes to verify files instead)
  return YAML.parse(fileContent, { maxAliasCount: -1 });
}

// Rebuilds a ComponentPopulated[] with proper JS object identity (for cycles) from
// the flat index-based answer format stored in the answer file.
function buildPopulatedFromAnswer(entries: AnswerEntry[]): ComponentPopulated[] {
  const nodes: ComponentPopulated[] = entries.map((e) => ({ id: e.id, name: e.name, dependencies: [] }));
  for (let i = 0; i < entries.length; i++) {
    for (const depIdx of entries[i].depIndices) {
      nodes[i].dependencies.push(nodes[depIdx]);
    }
  }
  return nodes;
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
    const answerData = buildPopulatedFromAnswer(loadYaml(answerEntry.filename) as AnswerEntry[]);

    const datasetReports: BenchmarkReport[] = [];

    for (const algo of algorithms) {
      console.log(`Running:[${algo.category}] ${algo.name}...`);

      let executionTimeMs = 0;
      let ramUsedMb = 0;
      let accuracyResult = { pass: false, errorDetail: null as string | null, nodesProcessed: 0, edgesTraversed: 0 };

      try {
        const startMem = process.memoryUsage().heapUsed;
        const startTime = performance.now();

        const result = algo.execute(inputData);

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

      console.log(`  Result: ${accuracyResult.pass ? '✅ PASS' : '❌ FAIL'} | Time: ${formatTime(report.metrics.timeMs)} | RAM: ${formatRam(report.metrics.ramMb)}`);

      // Strict boolean expression check
      if (accuracyResult.pass === false) {
        const previewError = (accuracyResult.errorDetail ?? '').substring(0, 100).replace(/\n/g, ' ');
        console.log(`  Error Detail: ${previewError}...`);
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
