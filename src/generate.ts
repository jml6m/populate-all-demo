import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import seedrandom from 'seedrandom';
import YAML from 'yaml';

import { AnswerEntry, ComponentFlat } from './algorithms/types';
import config from './generate-config.json';
import { Manifest, ManifestEntry } from './types';

// Hardcoded seed ensures our test data is mathematically identical on every run
const SEED = 'populate-all-demo';

function generateDataset(size: number, seedSuffix: string) {
  const rng = seedrandom(`${SEED}-${seedSuffix}`);
  const flatComponents: ComponentFlat[] = [];

  // 1. Initialize all nodes.
  for (let i = 0; i < size; i++) {
    flatComponents.push({ id: `comp_${i}`, dependencies: [] });
  }

  // 2. Build a spanning chain comp_0 → comp_1 → … → comp_{n-1}.
  //    This guarantees every node is reachable from comp_0 by construction
  //    so the preflight validator always classifies these datasets as core-valid.
  //    comp_0 is the chain head and has no predecessors, giving it in-degree 0.
  for (let i = 0; i < size - 1; i++) {
    flatComponents[i].dependencies.push(`comp_${i + 1}`);
  }

  // 3. Add random extra edges to create cycles and graph variety.
  //    Targets are always drawn from {comp_1 … comp_{n-1}} so comp_0's
  //    in-degree remains 0 — preserving it as the unique auto-detectable root.
  for (let i = 0; i < size; i++) {
    const numExtra = Math.floor(rng() * 3); // 0 – 2 extra edges per node
    for (let d = 0; d < numExtra; d++) {
      // comp_0 (index 0) is never a target; choose from [1, size-1].
      const targetIdx = 1 + Math.floor(rng() * (size - 1));
      const targetId = `comp_${targetIdx}`;
      if (targetIdx !== i && !flatComponents[i].dependencies.includes(targetId)) {
        flatComponents[i].dependencies.push(targetId);
      }
    }
  }

  return { flatComponents };
}

/**
 * Generates a genuinely acyclic dataset (DAG).
 *
 * The generator guarantees two invariants by construction — no post-hoc
 * patching required:
 *
 *   1. Acyclicity — every edge goes from a lower-index node to a higher-index
 *      node, so the topological order is simply ascending index.
 *
 *   2. Single-root connectivity — a random spanning tree rooted at comp_0 is
 *      laid down first (step 2 below), ensuring every node is reachable from
 *      comp_0 regardless of what extra edges the RNG adds later.  comp_0 is
 *      index 0, so it can never be the target of a lower-to-higher-index edge;
 *      its in-degree is therefore always 0, making it the unique
 *      auto-detectable root.
 *
 * On this dataset:
 *   - Algorithms with memoization (Map Tracker, Two-Pass Wire, Tarjan SCC) pass
 *     cleanly: the same object is returned for each node regardless of how many
 *     times it is referenced as a dependency.
 *   - Naive Recursion fails: it creates a fresh object for every populate() call,
 *     so a node that appears as a dependency of multiple parents is represented by
 *     multiple distinct objects.  The comparers detect this identity mismatch.
 *
 * This makes acyclic-control a precise control: it isolates the shared-reference
 * requirement from the cycle-detection requirement.  An algorithm failing here
 * lacks memoization, not cycle-handling.
 */
function generateAcyclicDataset(size: number, seedSuffix: string) {
  const rng = seedrandom(`${SEED}-${seedSuffix}`);
  const flatComponents: ComponentFlat[] = [];

  // 1. Initialize all nodes.
  for (let i = 0; i < size; i++) {
    flatComponents.push({ id: `comp_${i}`, dependencies: [] });
  }

  // 2. Build a random spanning tree rooted at comp_0.
  //    For each node i (1 … n-1), pick a random parent j in [0, i-1] and add
  //    the directed edge j → i.  Because j < i always, the edge goes from a
  //    lower-index node to a higher-index node, preserving acyclicity.
  //    Every node except comp_0 receives exactly one spanning-tree parent, so:
  //      • comp_0 has no incoming spanning-tree edges (in-degree 0 — unique root).
  //      • Every other node is reachable from comp_0 via some path of tree edges.
  for (let i = 1; i < size; i++) {
    const parentIdx = Math.floor(rng() * i); // random j in [0, i-1]
    flatComponents[parentIdx].dependencies.push(`comp_${i}`);
  }

  // 3. Add random extra acyclic edges (lower-index → higher-index) to create
  //    the shared-reference patterns that expose missing memoization in
  //    Naive Recursion.  comp_0 (index 0) can never be a target of these
  //    edges (targets are always strictly greater than the source index), so
  //    comp_0's in-degree remains 0.
  for (let i = 0; i < size - 1; i++) {
    const remaining = size - 1 - i;
    const numExtra = Math.floor(rng() * 2); // 0 or 1 extra edge per node
    for (let d = 0; d < numExtra; d++) {
      const targetIdx = i + 1 + Math.floor(rng() * remaining);
      const targetId = `comp_${targetIdx}`;
      if (!flatComponents[i].dependencies.includes(targetId)) {
        flatComponents[i].dependencies.push(targetId);
      }
    }
  }

  return { flatComponents };
}

/**
 * Converts the flat input into an answer: same nodes, but dependency foreign-key strings
 * replaced by array indices. This avoids the deep YAML nesting that cyclic object
 * serialization (aliasDuplicateObjects) would produce for large graphs.
 */
function buildAnswerData(flatComponents: ComponentFlat[]): AnswerEntry[] {
  const idToIndex = new Map<string, number>();
  flatComponents.forEach((c, i) => idToIndex.set(c.id, i));
  return flatComponents.map((c) => ({
    id: c.id,
    depIndices: c.dependencies.map((depId) => idToIndex.get(depId)!),
  }));
}

function writeYaml<T>(subDir: string, preset: string, data: T): ManifestEntry {
  const yamlString = YAML.stringify(data);
  const contentHash = crypto.createHash('sha256').update(yamlString).digest('hex').slice(0, 8);
  const basename = `${preset}.${contentHash}.yaml`;
  // The manifest stores the subdirectory-prefixed path so the runner can
  // resolve the file relative to the data root.
  const filename = `${subDir}/${basename}`;
  const filePath = path.join(__dirname, config.outputDir, subDir, basename);
  fs.writeFileSync(filePath, yamlString, 'utf8');
  console.log(`✅ Wrote ${filename} (${(fs.statSync(filePath).size / 1024).toFixed(2)} KB)`);
  return { filename, contentHash };
}

function run() {
  // Optional --tier filter: when provided, only the named dataset is generated.
  // Mirrors the same --tier pattern used by runner.ts.
  const tierArgIndex = process.argv.indexOf('--tier');
  let tierFilter: string | null = null;
  if (tierArgIndex !== -1) {
    const tierName = process.argv.at(tierArgIndex + 1);
    if (tierName === undefined || tierName.startsWith('--')) {
      throw new Error('--tier requires a tier name argument (e.g. --tier basic)');
    }
    tierFilter = tierName;
  }

  // Force mode: bypass the idempotency guard and regenerate even when files are present.
  // Set POPULATE_ALL_FORCE=1 (via `npm run generate:force`) to activate.
  const forceRegen = process.env['POPULATE_ALL_FORCE'] === '1';

  const outputDir = path.join(__dirname, config.outputDir);
  const manifestPath = path.join(outputDir, 'manifest.json');

  // Determine which datasets to generate (all enabled ones, or just the filtered one).
  const datasetsToProcess = config.datasets.filter((d) => d.enabled && (tierFilter === null || d.name === tierFilter));

  if (datasetsToProcess.length === 0) {
    console.log(
      tierFilter !== null ? `⏭️  Dataset "${tierFilter}" is disabled or not found — nothing to generate.` : '⏭️  All datasets are disabled — nothing to generate.'
    );
    return;
  }

  // Idempotency guard: skip generation if every requested dataset's files are already present.
  // Use `npm run generate:force` to bypass this check and regenerate regardless.
  if (!forceRegen && fs.existsSync(manifestPath)) {
    const existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;

    const missingFiles = datasetsToProcess
      .flatMap((d) => [`${d.name}_input`, `${d.name}_answer`])
      .filter((key) => {
        const entry = existingManifest.files[key];
        return !entry || !fs.existsSync(path.join(outputDir, entry.filename));
      });

    if (missingFiles.length === 0) {
      const scope = tierFilter !== null ? `"${tierFilter}" dataset` : 'all datasets';
      console.log(`⚡ Data is already up-to-date (${scope}) — skipping generation.`);
      console.log(`   (Run \`npm run generate:force\` to regenerate regardless.)`);
      return;
    }

    console.log(`⚠️  Regenerating: missing entries for ${missingFiles.join(', ')}`);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // When filtering to a single tier, carry forward other tiers' manifest entries so
  // a partial generate doesn't erase the rest of the manifest.
  const manifestFiles: Record<string, ManifestEntry> = {};
  if (tierFilter !== null && fs.existsSync(manifestPath)) {
    const existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
    for (const [key, entry] of Object.entries(existingManifest.files)) {
      if (entry !== undefined) {
        manifestFiles[key] = entry;
      }
    }
  }

  for (const dataset of datasetsToProcess) {
    console.log(`\nGenerating ${dataset.name} Dataset (${dataset.size} nodes)...`);
    const { flatComponents } = dataset.acyclic ? generateAcyclicDataset(dataset.size, dataset.seedSuffix) : generateDataset(dataset.size, dataset.seedSuffix);

    // Create per-dataset subdirectory.
    const datasetDir = path.join(outputDir, dataset.name);
    fs.mkdirSync(datasetDir, { recursive: true });

    // Both generators guarantee by construction that comp_0 is the unique
    // zero-in-degree root and that every node is reachable from it, so the
    // preflight validator will always classify these datasets as core-valid.
    manifestFiles[`${dataset.name}_input`] = writeYaml(dataset.name, `${dataset.name}_input`, flatComponents);

    const answerData = buildAnswerData(flatComponents);
    manifestFiles[`${dataset.name}_answer`] = writeYaml(dataset.name, `${dataset.name}_answer`, answerData);
  }

  // When doing a full (unfiltered) generation, note any disabled datasets.
  if (tierFilter === null) {
    for (const dataset of config.datasets) {
      if (!dataset.enabled) {
        console.log(`⏭️  Skipping disabled dataset "${dataset.name}"`);
      }
    }
  }

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    files: manifestFiles,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\n✅ Wrote manifest.json`);
}

run();
