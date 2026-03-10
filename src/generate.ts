import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import seedrandom from 'seedrandom';
import YAML from 'yaml';

import config from './generate-config.json';

// Hardcoded seed ensures our test data is mathematically identical on every run
const SEED = 'mongoose-issue-16074';

interface ComponentFlat {
  id: string;
  name: string;
  dependencies: string[]; // Foreign Keys
}

interface ComponentPopulated {
  id: string;
  name: string;
  dependencies: ComponentPopulated[]; // True RAM Pointers
}

function generateDataset(size: number, seedSuffix: string) {
  const rng = seedrandom(`${SEED}-${seedSuffix}`);
  const flatComponents: ComponentFlat[] = [];
  const populatedMap = new Map<string, ComponentPopulated>();

  // 1. Initialize all nodes
  for (let i = 0; i < size; i++) {
    const id = `comp_${i}`;
    const name = `Component ${i}`;

    flatComponents.push({ id, name, dependencies: [] });
    populatedMap.set(id, { id, name, dependencies: [] });
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
        // Link the actual memory reference for the Answer file
        populatedMap.get(flatComponents[i].id)!.dependencies.push(populatedMap.get(targetId)!);
      }
    }
  }

  const populatedArray = Array.from(populatedMap.values());
  return { flatComponents, populatedArray };
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

function writeYaml<T>(preset: string, scriptHash: string, data: T, enableAliases: boolean): ManifestEntry {
  const yamlString = YAML.stringify(data, {
    aliasDuplicateObjects: enableAliases,
  });
  const contentHash = crypto.createHash('sha256').update(yamlString).digest('hex').slice(0, 8);
  const filename = `${preset}.${scriptHash}.${contentHash}.yaml`;
  const filePath = path.join(__dirname, config.outputDir, filename);
  fs.writeFileSync(filePath, yamlString, 'utf8');
  console.log(`✅ Wrote ${filename} (${(fs.statSync(filePath).size / 1024).toFixed(2)} KB)`);
  return { filename, contentHash };
}

function run() {
  const scriptHash = computeScriptHash();
  const manifestFiles: Record<string, ManifestEntry> = {};

  const outputDir = path.join(__dirname, config.outputDir);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  for (const dataset of config.datasets) {
    console.log(`\nGenerating ${dataset.name} Dataset (${dataset.size} nodes)...`);
    const { flatComponents, populatedArray } = generateDataset(dataset.size, dataset.seedSuffix);
    manifestFiles[`${dataset.name}_test`] = writeYaml(`${dataset.name}_test`, scriptHash, flatComponents, false);
    manifestFiles[`${dataset.name}_answer`] = writeYaml(`${dataset.name}_answer`, scriptHash, populatedArray, true);
  }

  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    scriptHash,
    files: manifestFiles,
  };
  const manifestPath = path.join(__dirname, config.outputDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`\n✅ Wrote manifest.json`);
}

run();
