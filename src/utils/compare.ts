import { ComponentPopulated } from '../algorithms/types';

/**
 * Cycle-aware graph comparator — O(V + E).
 *
 * Both the algorithm output and the answer YAML use object-identity (shared
 * references) to represent cycles.  We walk both graphs in parallel, keeping a
 * Map<actualNode, expectedNode> that records every pair we have already paired
 * together.  When we encounter a node we have already visited we verify that
 * the same expected node was previously paired with it, which validates that
 * both graphs have an identical reference-sharing / cycle structure.
 */
export function smartCompare(
  actual: unknown,
  expected: unknown
): { pass: boolean; errorDetail: string | null; nodesProcessed: number; edgesTraversed: number } {
  try {
    if (!Array.isArray(actual) || !Array.isArray(expected)) {
      return { pass: false, errorDetail: 'Both actual and expected must be arrays', nodesProcessed: 0, edgesTraversed: 0 };
    }

    if (actual.length !== expected.length) {
      return {
        pass: false,
        errorDetail: `Top-level array length mismatch: actual=${actual.length}, expected=${expected.length}`,
        nodesProcessed: 0,
        edgesTraversed: 0,
      };
    }

    // Maps actual node → its paired expected node (by object identity)
    const paired = new Map<ComponentPopulated, ComponentPopulated>();
    // Reverse map — expected node → its paired actual node — for O(1) collision checks
    const reversePaired = new Map<ComponentPopulated, ComponentPopulated>();
    let nodesProcessed = 0;
    // Each dependency link traversed (including back-edges to already-visited nodes)
    let edgesTraversed = 0;

    /**
     * Returns null on success, or an error string on the first mismatch found.
     */
    function compareNode(a: ComponentPopulated, e: ComponentPopulated): string | null {
      const alreadyPaired = paired.get(a);
      if (alreadyPaired !== undefined) {
        // We have visited this actual node before — verify the cycle points to
        // the same expected node we originally paired it with.
        if (alreadyPaired !== e) {
          return `Cycle structure mismatch at node "${a.id}": expected cycle target differs`;
        }
        return null; // cycle correctly matches — stop recursion here
      }

      // Check the reverse direction: if this expected node was already paired
      // with a *different* actual node, the structures diverge.
      const reversePairedActual = reversePaired.get(e);
      if (reversePairedActual !== undefined && reversePairedActual !== a) {
        return `Cycle structure mismatch: expected node "${e.id}" is paired with more than one actual node`;
      }

      // First visit — record the pairing before recursing (handles cycles).
      paired.set(a, e);
      reversePaired.set(e, a);
      nodesProcessed++;

      // Compare scalar fields.
      if (a.id !== e.id) {
        return `id mismatch: actual="${a.id}", expected="${e.id}"`;
      }
      if (a.name !== e.name) {
        return `name mismatch for id "${a.id}": actual="${a.name}", expected="${e.name}"`;
      }
      if (a.dependencies.length !== e.dependencies.length) {
        return `dependencies length mismatch for id "${a.id}": actual=${a.dependencies.length}, expected=${e.dependencies.length}`;
      }

      // Recurse into dependencies — each iteration is one edge traversal.
      for (let i = 0; i < a.dependencies.length; i++) {
        edgesTraversed++;
        const err = compareNode(a.dependencies[i], e.dependencies[i]);
        if (err !== null) return err;
      }

      return null;
    }

    const actualNodes = actual as ComponentPopulated[];
    const expectedNodes = expected as ComponentPopulated[];

    for (let i = 0; i < actualNodes.length; i++) {
      const err = compareNode(actualNodes[i], expectedNodes[i]);
      if (err !== null) {
        return { pass: false, errorDetail: err, nodesProcessed, edgesTraversed };
      }
    }

    return { pass: true, errorDetail: null, nodesProcessed, edgesTraversed };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      pass: false,
      errorDetail: errorMessage !== '' ? errorMessage : 'Assertion Error: Graph mismatch',
      nodesProcessed: 0,
      edgesTraversed: 0,
    };
  }
}
