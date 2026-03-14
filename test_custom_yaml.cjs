// Custom iterative YAML serializer for ComponentPopulated[]
// Uses an explicit stack to avoid call-stack recursion
const YAML = require('yaml');
const seedrandom = require('seedrandom');

function stringifyPopulatedIterative(nodes) {
  const anchors = new Map(); // node → anchor id
  let anchorCounter = 0;
  const lines = [];

  // Explicit task stack: each entry is a node to write with its indent and seq-item prefix
  const stack = [];

  // Push root nodes in reverse order so they're processed in original order
  for (let i = nodes.length - 1; i >= 0; i--) {
    stack.push({ node: nodes[i], indent: '', prefix: '- ' });
  }

  while (stack.length > 0) {
    const { node, indent, prefix } = stack.pop();

    if (anchors.has(node)) {
      // Already anchored: write alias
      lines.push(`${indent}${prefix}*${anchors.get(node)}`);
      continue;
    }

    // First encounter: assign anchor and write full content
    const anchor = `n${anchorCounter++}`;
    anchors.set(node, anchor);

    lines.push(`${indent}${prefix}&${anchor}`);
    lines.push(`${indent}  id: ${node.id}`);
    lines.push(`${indent}  name: ${node.name}`);

    if (node.dependencies.length === 0) {
      lines.push(`${indent}  dependencies: []`);
    } else {
      lines.push(`${indent}  dependencies:`);
      // Push dependencies in REVERSE order so they're processed (and written) in FORWARD order
      for (let i = node.dependencies.length - 1; i >= 0; i--) {
        stack.push({ node: node.dependencies[i], indent: indent + '    ', prefix: '- ' });
      }
    }
  }

  return lines.join('\n') + '\n';
}

function generateDataset(size, seedSuffix) {
  const rng = seedrandom('populate-all-demo-' + seedSuffix);
  const flat = [];
  for (let i = 0; i < size; i++) flat.push({ id: 'comp_' + i, name: 'Component ' + i, dependencies: [] });
  for (let i = 0; i < size; i++) {
    const numDeps = Math.floor(rng() * 3) + 1;
    for (let d = 0; d < numDeps; d++) {
      const targetIdx = Math.floor(rng() * size);
      if (targetIdx !== i && !flat[i].dependencies.includes('comp_' + targetIdx)) {
        flat[i].dependencies.push('comp_' + targetIdx);
      }
    }
  }
  return flat;
}

function buildPopulated(flat) {
  const map = new Map();
  for (const c of flat) map.set(c.id, { id: c.id, name: c.name, dependencies: [] });
  for (const c of flat) {
    const n = map.get(c.id);
    for (const d of c.dependencies) n.dependencies.push(map.get(d));
  }
  return Array.from(map.values());
}

// Test 1: 2-node cycle
const a = { id: 'a', name: 'A', dependencies: [] };
const b = { id: 'b', name: 'B', dependencies: [] };
a.dependencies.push(b);
b.dependencies.push(a);
const cycleYaml = stringifyPopulatedIterative([a, b]);
console.log('2-node cycle:');
console.log(cycleYaml);

// Parse it back and verify cycle structure
const parsed = YAML.parse(cycleYaml, { maxAliasCount: -1 });
console.log('Parse back: parsed[0].deps[0] === parsed[1]:', parsed[0].dependencies[0] === parsed[1]);
console.log('Parse back: parsed[1].deps[0] === parsed[0]:', parsed[1].dependencies[0] === parsed[0]);

// Test 2: medium dataset (5000 nodes)
console.log('\nTesting medium dataset (5000 nodes)...');
const start = Date.now();
const flat = generateDataset(5000, 'medium');
const pop = buildPopulated(flat);
const yaml = stringifyPopulatedIterative(pop);
const elapsed = Date.now() - start;
console.log(`Generated: ${(yaml.length / 1024).toFixed(2)} KB in ${elapsed}ms`);

// Parse back and verify
const start2 = Date.now();
const parsedMedium = YAML.parse(yaml, { maxAliasCount: -1 });
const elapsed2 = Date.now() - start2;
console.log(`Parsed: ${parsedMedium.length} nodes in ${elapsed2}ms`);
console.log('First node id:', parsedMedium[0].id);

// Verify cycle structure: check that parsed[0].deps contain actual object refs
let cycleFound = false;
const visited = new Set();
function checkCycles(node) {
  if (visited.has(node)) { cycleFound = true; return; }
  visited.add(node);
  for (const d of node.dependencies) checkCycles(d);
}
// Use iterative check to avoid recursion
const iterStack = [parsedMedium[0]];
const iVisited = new Set();
while (iterStack.length > 0) {
  const n = iterStack.pop();
  if (iVisited.has(n)) { cycleFound = true; continue; }
  iVisited.add(n);
  for (const d of n.dependencies) iterStack.push(d);
  if (cycleFound && iVisited.size > 10) break; // early exit once confirmed
}
console.log('Cycles detected in loaded data:', cycleFound);
