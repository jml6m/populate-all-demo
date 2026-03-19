import { ComponentPopulated } from '../algorithms/types';

/** Explicit call-frame type used by the iterative DFS stack in compareNode. */
interface CompareFrame { a: ComponentPopulated; e: ComponentPopulated; depIdx: number }

/**
 * Cycle-aware graph comparator — O(V + E).
 *
 * Both the algorithm output and the expected graph use object-identity (shared
 * references) to represent cycles.  We walk both graphs in parallel, keeping a
 * Map<actualNode, expectedNode> that records every pair we have already paired
 * together.  When we encounter a node we have already visited we verify that
 * the same expected node was previously paired with it, which validates that
 * both graphs have an identical reference-sharing / cycle structure.
 *
 * The traversal is an iterative DFS (explicit frame stack) to avoid call-stack
 * overflow on large cyclic graphs.
 *
 * @param options.verbose  When true, emits step-by-step logs via console.log
 *                         with a `[smartCompare]` prefix.  Does not affect the
 *                         return value or algorithm behaviour.
 */
export function smartCompare(
  actual: unknown,
  expected: unknown,
  options?: { verbose?: boolean }
): { pass: boolean; errorDetail: string | null; nodesProcessed: number; edgesTraversed: number } {
  const verbose = options?.verbose === true;
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
     * Iterative DFS over the sub-graph reachable from (startA, startE).
     * Returns null on success, or an error string on the first mismatch found.
     */
    function compareNode(startA: ComponentPopulated, startE: ComponentPopulated): string | null {
      // Fast path: node was already processed (outer-loop revisit or cycle back-edge)
      const initialPaired = paired.get(startA);
      if (initialPaired !== undefined) {
        return initialPaired !== startE ? `Cycle structure mismatch at node "${startA.id}": expected cycle target differs` : null;
      }

      const reverseStart = reversePaired.get(startE);
      if (reverseStart !== undefined && reverseStart !== startA) {
        return `Cycle structure mismatch: expected node "${startE.id}" is paired with more than one actual node`;
      }

      // Record the start node before pushing it to the stack (handles cycles)
      paired.set(startA, startE);
      reversePaired.set(startE, startA);
      nodesProcessed++;
      if (verbose) console.log(`[smartCompare] PAIR: ${startA.id} ↔ ${startE.id} [nodesProcessed=${nodesProcessed}]`);

      if (startA.id !== startE.id) return `id mismatch: actual="${startA.id}", expected="${startE.id}"`;
      if (startA.dependencies.length !== startE.dependencies.length) {
        return `dependencies length mismatch for id "${startA.id}": actual=${startA.dependencies.length}, expected=${startE.dependencies.length}`;
      }
      if (verbose) console.log(`[smartCompare] CHECK ${startA.id}: id ✓, deps.length=${startA.dependencies.length} ✓`);

      // Explicit frame stack: mirrors the recursive call frames
      const stack: CompareFrame[] = [{ a: startA, e: startE, depIdx: 0 }];

      while (stack.length > 0) {
        const frame = stack[stack.length - 1];

        if (frame.depIdx >= frame.a.dependencies.length) {
          stack.pop();
          continue;
        }

        const da = frame.a.dependencies[frame.depIdx];
        const de = frame.e.dependencies[frame.depIdx];
        frame.depIdx++;
        // Count every dependency link traversed, including back-edges
        edgesTraversed++;
        if (verbose) console.log(`[smartCompare] EDGE: ${frame.a.id} → ${da.id} [edgesTraversed=${edgesTraversed}]`);

        const alreadyPaired = paired.get(da);
        if (alreadyPaired !== undefined) {
          // Back-edge: verify the cycle points to the same expected node
          if (alreadyPaired !== de) {
            return `Cycle structure mismatch at node "${da.id}": expected cycle target differs`;
          }
          if (verbose) console.log(`[smartCompare] BACK-EDGE: ${da.id} already paired ✓`);
          continue;
        }

        const reversePairedActual = reversePaired.get(de);
        if (reversePairedActual !== undefined && reversePairedActual !== da) {
          return `Cycle structure mismatch: expected node "${de.id}" is paired with more than one actual node`;
        }

        // First visit: record before pushing (handles any intra-subtree cycles)
        paired.set(da, de);
        reversePaired.set(de, da);
        nodesProcessed++;
        if (verbose) console.log(`[smartCompare] PAIR: ${da.id} ↔ ${de.id} [nodesProcessed=${nodesProcessed}]`);

        if (da.id !== de.id) return `id mismatch: actual="${da.id}", expected="${de.id}"`;
        if (da.dependencies.length !== de.dependencies.length) {
          return `dependencies length mismatch for id "${da.id}": actual=${da.dependencies.length}, expected=${de.dependencies.length}`;
        }
        if (verbose) console.log(`[smartCompare] CHECK ${da.id}: id ✓, deps.length=${da.dependencies.length} ✓`);

        stack.push({ a: da, e: de, depIdx: 0 });
      }

      return null;
    }

    const actualNodes = actual as ComponentPopulated[];
    const expectedNodes = expected as ComponentPopulated[];

    for (let i = 0; i < actualNodes.length; i++) {
      const err = compareNode(actualNodes[i], expectedNodes[i]);
      if (err !== null) {
        if (verbose) console.log(`[smartCompare] DONE: pass=false, nodesProcessed=${nodesProcessed}, edgesTraversed=${edgesTraversed}`);
        return { pass: false, errorDetail: err, nodesProcessed, edgesTraversed };
      }
    }

    if (verbose) console.log(`[smartCompare] DONE: pass=true, nodesProcessed=${nodesProcessed}, edgesTraversed=${edgesTraversed}`);
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
