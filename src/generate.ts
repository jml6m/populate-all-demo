import fs from 'fs';
import path from 'path';
import seedrandom from 'seedrandom';
import YAML from 'yaml';

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

function writeYaml(filename: string, data: any, enableAliases: boolean) {
  const filePath = path.join(__dirname, '../data', filename);
  const yamlString = YAML.stringify(data, {
    // This is the magic flag for YAML 1.2:
    // It detects RAM cycles and turns them into &anchors and *aliases
    aliasDuplicateObjects: enableAliases,
  });
  fs.writeFileSync(filePath, yamlString, 'utf8');
  console.log(`✅ Wrote ${filename} (${(fs.statSync(filePath).size / 1024).toFixed(2)} KB)`);
}

function run() {
  console.log('Generating Basic Dataset (10 nodes)...');
  const basic = generateDataset(10, 'basic');
  writeYaml('basic_test.yaml', basic.flatComponents, false);
  writeYaml('basic_answer.yaml', basic.populatedArray, true);

  console.log('\nGenerating Stress Dataset (1,000 nodes)...');
  const stress = generateDataset(1000, 'stress');
  writeYaml('stress_test.yaml', stress.flatComponents, false);
  writeYaml('stress_answer.yaml', stress.populatedArray, true);
}

run();
