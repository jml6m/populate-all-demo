import assert from 'assert';

export function smartCompare(actual: any, expected: any): { pass: boolean; errorDetail: string | null; nodesProcessed: number } {
  try {
    assert.deepStrictEqual(actual, expected);
    
    const visited = new Set<any>();
    function countNodes(nodes: any[]): number {
      let count = 0;
      for (const node of nodes) {
        if (!visited.has(node)) {
          visited.add(node);
          count++;
          if (node.dependencies) {
            count += countNodes(node.dependencies);
          }
        }
      }
      return count;
    }
    
    return { pass: true, errorDetail: null, nodesProcessed: countNodes(actual) };
  } catch (error: any) {
    return { 
      pass: false, 
      errorDetail: error.message || 'Assertion Error: Graph mismatch',
      nodesProcessed: 0
    };
  }
}