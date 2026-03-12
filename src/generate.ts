import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import seedrandom from 'seedrandom';
import YAML from 'yaml';

import config from './generate-config.json';

// Hardcoded seed ensures our test data is mathematically identical on every run
const SEED = 'populate-all-demo';

interface ComponentFlat {
  id: string;
  name: string;
  dependencies: string[]; // Foreign Keys
}

function generateDataset(size: number, seedSuffix: string) {
  const rng = seedrandom(`${SEED}-${seedSuffix}`);
  const flatComponents: ComponentFlat[] = [];

  // 1. Initialize all nodes
  for (let i = 0; i < size; i++) {
    flatComponents.push({ id: `comp_${i}`, name: `Component ${i}`, dependencies: [] });
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

function computeScriptHash(): string {
  const content = fs.readFileSync(__filename);
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
}

interface ManifestEntry {
  filename: string;
  contentHash: string;
}

interface Manifest {
  generatedAt: string;
  scriptHash: string;
  files: Record<string, ManifestEntry>;
}

function writeYaml<T>(subDir: string, preset: string, scriptHash: string, data: T): ManifestEntry {
  const yamlString = YAML.stringify(data);
  const contentHash = crypto.createHash('sha256').update(yamlString).digest('hex').slice(0, 8);
  const basename = `${preset}.${scriptHash}.${contentHash}.yaml`;
  // The manifest stores the subdirectory-prefixed path so the runner can
  // resolve the file relative to the data root.
  const filename = `${subDir}/${scriptHash}/${basename}`;
  const filePath = path.join(__dirname, config.outputDir, subDir, scriptHash, basename);
  fs.writeFileSync(filePath, yamlString, 'utf8');
  console.log(`✅ Wrote ${filename} (${(fs.statSync(filePath).size / 1024).toFixed(2)} KB)`);
  return { filename, contentHash };
}

function run() {
  const scriptHash = computeScriptHash();

  const outputDir = path.join(__dirname, config.outputDir);
  const manifestPath = path.join(outputDir, 'manifest.json');

  // Idempotency guard: skip all generation if the manifest was produced by the
  // same version of this script AND every file it references still exists on disk.
  if (fs.existsSync(manifestPath)) {
    const existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
    if (existingManifest.scriptHash === scriptHash) {
      const missingFiles = Object.entries(existingManifest.files)
        .filter(([, { filename }]) => !fs.existsSync(path.join(outputDir, filename)))
        .map(([key]) => key);

      if (missingFiles.length === 0) {
        console.log(`⚡ Data is already up-to-date for scriptHash=${scriptHash} — skipping generation.`);
        console.log(`   (Delete data/manifest.json to force a full regeneration.)`);
        return;
      }

      console.log(`⚠️  Manifest matches scriptHash=${scriptHash} but ${missingFiles.length} file(s) are missing: ${missingFiles.join(', ')}. Regenerating...`);
    } else {
      console.log(`📦 Script changed (old: ${existingManifest.scriptHash} → new: ${scriptHash}). Regenerating...`);
    }
  }

  const manifestFiles: Record<string, ManifestEntry> = {};

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const dataset of config.datasets) {
    console.log(`\nGenerating ${dataset.name} Dataset (${dataset.size} nodes)...`);
    const { flatComponents } = generateDataset(dataset.size, dataset.seedSuffix);

    // Create per-dataset/per-scriptHash subdirectory.
    const datasetRunDir = path.join(outputDir, dataset.name, scriptHash);
    fs.mkdirSync(datasetRunDir, { recursive: true });

    manifestFiles[`${dataset.name}_test`] = writeYaml(dataset.name, `${dataset.name}_test`, scriptHash, flatComponents);
  }

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    scriptHash,
    files: manifestFiles,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\n✅ Wrote manifest.json`);
}

run();
