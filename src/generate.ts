import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import seedrandom from 'seedrandom';
import YAML from 'yaml';

import config from './generate-config.json';
import { AnswerEntry, ComponentFlat } from './algorithms/types';
import { Manifest, ManifestEntry } from './types';

// Hardcoded seed ensures our test data is mathematically identical on every run
const SEED = 'populate-all-demo';

function generateDataset(size: number, seedSuffix: string) {
  const rng = seedrandom(`${SEED}-${seedSuffix}`);
  const flatComponents: ComponentFlat[] = [];

  // 1. Initialize all nodes
  for (let i = 0; i < size; i++) {
    flatComponents.push({ id: `comp_${i}`, dependencies: [] });
  }

  // 2. Assign edges (dependencies) to create cyclic graphs
  for (let i = 0; i < size; i++) {
    const numDeps = Math.floor(rng() * 3) + 1; // Each component has 1 to 3 dependencies

    for (let d = 0; d < numDeps; d++) {
      const targetIdx = Math.floor(rng() * size);
      const targetId = `comp_${targetIdx}`;

      // Prevent immediate self-loop (comp_1 -> comp_1) to ensure deep, complex cycles
      if (targetIdx !== i && !flatComponents[i].dependencies.includes(targetId)) {
        flatComponents[i].dependencies.push(targetId);
      }
    }
  }

  return { flatComponents };
}

// Converts the flat input into an answer: same nodes, but dependency foreign-key strings
// replaced by array indices. This avoids the deep YAML nesting that cyclic object
// serialization (aliasDuplicateObjects) would produce for large graphs.
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
  const outputDir = path.join(__dirname, config.outputDir);
  const manifestPath = path.join(outputDir, 'manifest.json');

  // Idempotency guard: skip if manifest exists, every file it references is present on disk,
  // and the manifest's dataset keys match the currently enabled datasets.
  if (fs.existsSync(manifestPath)) {
    const existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
    const missingFiles = Object.entries(existingManifest.files)
      .filter(([, entry]) => !entry || !fs.existsSync(path.join(outputDir, entry.filename)))
      .map(([key]) => key);

    // Compute the set of expected manifest keys based on currently enabled datasets.
    const expectedManifestKeys = new Set<string>();
    for (const dataset of config.datasets) {
      if (!dataset.enabled) continue;
      expectedManifestKeys.add(`${dataset.name}_input`);
      expectedManifestKeys.add(`${dataset.name}_answer`);
    }

    const existingManifestKeys = new Set<string>(Object.keys(existingManifest.files));

    const missingManifestKeys: string[] = [];
    for (const key of expectedManifestKeys) {
      if (!existingManifestKeys.has(key)) {
        missingManifestKeys.push(key);
      }
    }

    const extraManifestKeys: string[] = [];
    for (const key of existingManifestKeys) {
      if (!expectedManifestKeys.has(key)) {
        extraManifestKeys.push(key);
      }
    }

    const hasManifestKeyMismatch = missingManifestKeys.length > 0 || extraManifestKeys.length > 0;

    if (missingFiles.length === 0 && !hasManifestKeyMismatch) {
      console.log(`⚡ Data is already up-to-date — skipping generation.`);
      console.log(`   (Delete data/manifest.json to force a full regeneration.)`);
      return;
    }

    const reasons: string[] = [];
    if (missingFiles.length > 0) {
      reasons.push(`${missingFiles.length} file(s) are missing: ${missingFiles.join(', ')}`);
    }
    if (hasManifestKeyMismatch) {
      const parts: string[] = [];
      if (missingManifestKeys.length > 0) {
        parts.push(`missing manifest entries for enabled datasets: ${missingManifestKeys.join(', ')}`);
      }
      if (extraManifestKeys.length > 0) {
        parts.push(`manifest contains entries no longer expected from config: ${extraManifestKeys.join(', ')}`);
      }
      reasons.push(parts.join('; '));
    }

    console.log(`⚠️  Manifest exists but ${reasons.join(' | ')}. Regenerating...`);
  }

  const manifestFiles: Record<string, ManifestEntry> = {};

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const dataset of config.datasets) {
    if (!dataset.enabled) {
      console.log(`⏭️  Skipping disabled dataset "${dataset.name}"`);
      continue;
    }

    console.log(`\nGenerating ${dataset.name} Dataset (${dataset.size} nodes)...`);
    const { flatComponents } = generateDataset(dataset.size, dataset.seedSuffix);

    // Create per-dataset subdirectory.
    const datasetDir = path.join(outputDir, dataset.name);
    fs.mkdirSync(datasetDir, { recursive: true });

    manifestFiles[`${dataset.name}_input`] = writeYaml(dataset.name, `${dataset.name}_input`, flatComponents);

    const answerData = buildAnswerData(flatComponents);
    manifestFiles[`${dataset.name}_answer`] = writeYaml(dataset.name, `${dataset.name}_answer`, answerData);
  }

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    files: manifestFiles,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\n✅ Wrote manifest.json`);
}

run();
