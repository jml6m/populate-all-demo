// Test: iterative YAML document construction using yaml library's Document API
const YAML = require('yaml');

function buildYamlDocumentIteratively(data) {
  const doc = new YAML.Document();
  const objectToNode = new Map();

  function getOrCreateNode(obj) {
    if (objectToNode.has(obj)) {
      return objectToNode.get(obj);
    }

    if (Array.isArray(obj)) {
      const seqNode = doc.createNode([]);
      seqNode.flow = false;
      objectToNode.set(obj, seqNode);
      // Fill items iteratively
      for (const item of obj) {
        seqNode.items.push(getOrCreateNode(item));
      }
      return seqNode;
    } else if (obj !== null && typeof obj === 'object') {
      const mapNode = doc.createNode({});
      objectToNode.set(obj, mapNode);
      for (const [key, val] of Object.entries(obj)) {
        const keyNode = doc.createNode(key);
        const valNode = getOrCreateNode(val);
        mapNode.add({ key: keyNode, value: valNode });
      }
      return mapNode;
    } else {
      return doc.createNode(obj);
    }
  }

  doc.contents = getOrCreateNode(data);
  return doc;
}

// Test with a 2-node cycle
const a = { id: 'a', name: 'A', dependencies: [] };
const b = { id: 'b', name: 'B', dependencies: [] };
a.dependencies.push(b);
b.dependencies.push(a);

const doc = buildYamlDocumentIteratively([a, b]);
const yaml = doc.toString();
console.log('Small cycle test:');
console.log(yaml);
