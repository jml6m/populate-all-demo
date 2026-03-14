// Test: building a YAML document with anchors/aliases iteratively using yaml library's Node API
import YAML from 'yaml';

interface ComponentPopulated {
  id: string;
  name: string;
  dependencies: ComponentPopulated[];
}

// Iterative YAML serializer for ComponentPopulated[] graphs with cycles
// Produces YAML where every node is a top-level anchor, and dependencies use aliases.
// This avoids the deep recursion in YAML.stringify.
function stringifyPopulated(nodes: ComponentPopulated[]): string {
  // Assign a numeric anchor index to every unique node
  const nodeToAnchor = new Map<ComponentPopulated, string>();
  for (let i = 0; i < nodes.length; i++) {
    nodeToAnchor.set(nodes[i], `n${i}`);
  }

  // Build the YAML document using the Node API
  const doc = new YAML.Document();
  const nodeToYAMLMap = new Map<ComponentPopulated, YAML.YAMLMap>();

  // First pass: create YAMLMap shells for all nodes with anchors
  for (const node of nodes) {
    const anchor = nodeToAnchor.get(node)!;
    const map = new YAML.YAMLMap(doc.schema);
    map.anchor = anchor;
    map.add({ key: doc.createNode('id'), value: doc.createNode(node.id) });
    map.add({ key: doc.createNode('name'), value: doc.createNode(node.name) });
    nodeToYAMLMap.set(node, map);
  }

  // Second pass: add dependency sequences using aliases
  for (const node of nodes) {
    const map = nodeToYAMLMap.get(node)!;
    const depsSeq = new YAML.YAMLSeq(doc.schema);
    for (const dep of node.dependencies) {
      const depAnchor = nodeToAnchor.get(dep);
      if (depAnchor !== undefined) {
        // Reference to a known node: use alias
        const alias = new YAML.Alias(depAnchor);
        depsSeq.add(alias);
      } else {
        // Unknown node (shouldn't happen in well-formed data)
        depsSeq.add(doc.createNode(dep));
      }
    }
    map.add({ key: doc.createNode('dependencies'), value: depsSeq });
  }

  // Build root sequence
  const rootSeq = new YAML.YAMLSeq(doc.schema);
  for (const node of nodes) {
    rootSeq.add(nodeToYAMLMap.get(node)!);
  }
  doc.contents = rootSeq;

  return doc.toString();
}

// Test with a 2-node cycle
const a: ComponentPopulated = { id: 'a', name: 'A', dependencies: [] };
const b: ComponentPopulated = { id: 'b', name: 'B', dependencies: [] };
a.dependencies.push(b);
b.dependencies.push(a);

const yaml = stringifyPopulated([a, b]);
console.log('Serialized:');
console.log(yaml);

// Parse it back
const parsed = YAML.parse(yaml, { maxAliasCount: -1 }) as ComponentPopulated[];
console.log('Parsed back:');
console.log(JSON.stringify(parsed[0].id)); // 'a'
console.log('Cycle check: parsed[0].deps[0] === parsed[1]:', parsed[0].dependencies[0] === parsed[1]); // true
console.log('Cycle check: parsed[1].deps[0] === parsed[0]:', parsed[1].dependencies[0] === parsed[0]); // true
