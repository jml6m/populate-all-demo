import { ComponentPopulated } from '../algorithms/types';

/** Explicit call-frame type used by the iterative DFS stack in compareNode. */
interface CompareFrame {
  a: ComponentPopulated;
  e: ComponentPopulated;
  depIdx: number;
}

/** Shared no-op used when verbose=false to avoid allocating a new function on every smartCompare call. */
function noop(_msg: string): void {
  /* intentionally empty */
}

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
 * @param verbose When true, prints a per-node pairing trace (prefixed [smartCompare]) to stdout.
 */
export function smartCompare(
  actual: unknown,
  expected: unknown,
  verbose = false
): { pass: boolean; errorDetail: string | null; nodesProcessed: number; edgesTraversed: number } {
  const log = verbose ? (msg: string) => console.log(msg) : noop;

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
      // Fast path: this node was already visited as a dependency of an earlier root node.
      // Cycle back-edges within the DFS are handled below in the stack loop (via paired.get(da)).
      const initialPaired = paired.get(startA);
      if (initialPaired !== undefined) {
        if (initialPaired !== startE) {
          log(`[smartCompare] ❌ Mismatch: node "${startA.id}" was previously paired with "${initialPaired.id}" but now expected "${startE.id}"`);
          return `Cycle structure mismatch at node "${startA.id}": expected cycle target differs`;
        }
        log(`[smartCompare] Already paired (outer revisit): actual="${startA.id}" ↔ expected="${startE.id}" ✓`);
        return null;
      }

      const reverseStart = reversePaired.get(startE);
      if (reverseStart !== undefined && reverseStart !== startA) {
        log(`[smartCompare] ❌ Mismatch: expected node "${startE.id}" claimed by both "${reverseStart.id}" and "${startA.id}"`);
        return `Cycle structure mismatch: expected node "${startE.id}" is paired with more than one actual node`;
      }

      // Record the start node before pushing it to the stack (handles cycles)
      paired.set(startA, startE);
      reversePaired.set(startE, startA);
      nodesProcessed++;

      if (startA.id !== startE.id) {
        log(`[smartCompare] ❌ id mismatch: actual="${startA.id}", expected="${startE.id}"`);
        return `id mismatch: actual="${startA.id}", expected="${startE.id}"`;
      }
      if (startA.dependencies.length !== startE.dependencies.length) {
        log(`[smartCompare] ❌ dep-count mismatch for "${startA.id}": actual=${startA.dependencies.length}, expected=${startE.dependencies.length}`);
        return `dependencies length mismatch for id "${startA.id}": actual=${startA.dependencies.length}, expected=${startE.dependencies.length}`;
      }

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
        // Count every dependency link traversed, including back-edges.
        // Each traversal produces exactly one log line below.
        edgesTraversed++;

        const alreadyPaired = paired.get(da);
        if (alreadyPaired !== undefined) {
          // Back-edge: verify the cycle points to the same expected node
          if (alreadyPaired !== de) {
            log(`[smartCompare] ❌ EDGE #${edgesTraversed} ${frame.a.id}→${da.id}: back-edge mismatch, paired with "${alreadyPaired.id}" but expected "${de.id}"`);
            return `Cycle structure mismatch at node "${da.id}": expected cycle target differs`;
          }
          log(`[smartCompare] EDGE #${edgesTraversed} ${frame.a.id}→${da.id}: back-edge ↔ ${de.id} ✓`);
          continue;
        }

        const reversePairedActual = reversePaired.get(de);
        if (reversePairedActual !== undefined && reversePairedActual !== da) {
          log(`[smartCompare] ❌ EDGE #${edgesTraversed} ${frame.a.id}→${da.id}: expected "${de.id}" already paired with "${reversePairedActual.id}"`);
          return `Cycle structure mismatch: expected node "${de.id}" is paired with more than one actual node`;
        }

        // First visit: record before pushing (handles any intra-subtree cycles)
        paired.set(da, de);
        reversePaired.set(de, da);
        nodesProcessed++;
        log(`[smartCompare] EDGE #${edgesTraversed} ${frame.a.id}→${da.id}: new, paired "${da.id}"↔"${de.id}" (${da.dependencies.length} deps)`);

        if (da.id !== de.id) {
          log(`[smartCompare] ❌ id mismatch: actual="${da.id}", expected="${de.id}"`);
          return `id mismatch: actual="${da.id}", expected="${de.id}"`;
        }
        if (da.dependencies.length !== de.dependencies.length) {
          log(`[smartCompare] ❌ dep-count mismatch for "${da.id}": actual=${da.dependencies.length}, expected=${de.dependencies.length}`);
          return `dependencies length mismatch for id "${da.id}": actual=${da.dependencies.length}, expected=${de.dependencies.length}`;
        }

        stack.push({ a: da, e: de, depIdx: 0 });
      }

      return null;
    }

    const actualNodes = actual as ComponentPopulated[];
    const expectedNodes = expected as ComponentPopulated[];

    if (verbose) {
      log(`\n--- smartCompare: comparing ${actualNodes.length} root node(s) ---`);
    }

    for (let i = 0; i < actualNodes.length; i++) {
      if (verbose) log(`[smartCompare] Root[${i}]: actual="${actualNodes[i].id}" vs expected="${expectedNodes[i].id}"`);
      const err = compareNode(actualNodes[i], expectedNodes[i]);
      if (err !== null) {
        log(`[smartCompare] ❌ FAIL — ${err}`);
        return { pass: false, errorDetail: err, nodesProcessed, edgesTraversed };
      }
    }

    if (verbose) {
      log(`[smartCompare] ✅ PASS — ${nodesProcessed} nodes, ${edgesTraversed} edges`);
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
