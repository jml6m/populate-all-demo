import assert from 'assert';
import { ComponentPopulated } from '../algorithms/types';

export function smartCompare(actual: unknown, expected: unknown): { pass: boolean; errorDetail: string | null; nodesProcessed: number } {
  try {
    assert.deepStrictEqual(actual, expected);

    const visited = new Set<ComponentPopulated>();

    function countNodes(nodes: ComponentPopulated[]): number {
      let count = 0;
      for (const node of nodes) {
        if (!visited.has(node)) {
          visited.add(node);
          count++;
          count += countNodes(node.dependencies);
        }
      }
      return count;
    }

    // We know 'actual' passed deepStrictEqual, so it safely matches our populated array structure
    const actualNodes = actual as ComponentPopulated[];

    return { pass: true, errorDetail: null, nodesProcessed: countNodes(actualNodes) };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      pass: false,
      errorDetail: errorMessage !== '' ? errorMessage : 'Assertion Error: Graph mismatch',
      nodesProcessed: 0,
    };
  }
}
