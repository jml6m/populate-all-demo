import { ComponentFlat, ComponentPopulated, PopulateAlgorithm } from '../types';

export const tarjanSccLayering: PopulateAlgorithm = {
  name: 'Tarjan SCC Layering',
  category: 'Topological',
  timeComplexity: 'O(V + E)',
  spaceComplexity: 'O(V)',
  description:
    "Uses Tarjan's strongly connected components algorithm to condense the graph into a DAG of SCCs, then processes each SCC layer-by-layer. Nodes in the same SCC share object references for cycle safety.",
  execute: (flatDatabaseState: ComponentFlat[]): ComponentPopulated[] => {
    const dbMap = new Map<string, ComponentFlat>();
    for (const comp of flatDatabaseState) {
      dbMap.set(comp.id, comp);
    }

    // --- Tarjan's SCC (iterative to avoid call-stack overflow on large graphs) ---
    const index = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Map<string, boolean>();
    const stack: string[] = [];
    const sccs: string[][] = [];
    let counter = 0;

    function strongconnectIterative(startId: string): void {
      // Each frame: { id, depIndex } — depIndex tracks which dependency we're processing next
      interface Frame {
        id: string;
        depIndex: number;
      }
      const callStack: Frame[] = [{ id: startId, depIndex: 0 }];

      index.set(startId, counter);
      lowlink.set(startId, counter);
      counter++;
      stack.push(startId);
      onStack.set(startId, true);

      while (callStack.length > 0) {
        const frame = callStack[callStack.length - 1];
        const flat = dbMap.get(frame.id);
        const deps = flat ? flat.dependencies : [];

        if (frame.depIndex < deps.length) {
          const depId = deps[frame.depIndex];
          frame.depIndex++;

          if (!index.has(depId)) {
            // Push new frame (recurse into depId)
            index.set(depId, counter);
            lowlink.set(depId, counter);
            counter++;
            stack.push(depId);
            onStack.set(depId, true);
            callStack.push({ id: depId, depIndex: 0 });
          } else if (onStack.get(depId) === true) {
            lowlink.set(frame.id, Math.min(lowlink.get(frame.id)!, index.get(depId)!));
          }
        } else {
          // All deps of frame.id processed — pop and update parent's lowlink
          callStack.pop();
          if (callStack.length > 0) {
            const parent = callStack[callStack.length - 1];
            lowlink.set(parent.id, Math.min(lowlink.get(parent.id)!, lowlink.get(frame.id)!));
          }

          // Check if frame.id is a root of an SCC
          if (lowlink.get(frame.id) === index.get(frame.id)) {
            const scc: string[] = [];
            let w: string;
            do {
              w = stack.pop()!;
              onStack.set(w, false);
              scc.push(w);
            } while (w !== frame.id);
            sccs.push(scc);
          }
        }
      }
    }

    for (const comp of flatDatabaseState) {
      if (!index.has(comp.id)) {
        strongconnectIterative(comp.id);
      }
    }

    // --- Build populated nodes, one per flat component ---
    // Pre-allocate all ComponentPopulated objects (without dependencies) so that
    // cycles within an SCC resolve to the same JS object reference.
    const populated = new Map<string, ComponentPopulated>();
    for (const comp of flatDatabaseState) {
      populated.set(comp.id, { id: comp.id, name: comp.name, dependencies: [] });
    }

    // --- Wire dependencies ---
    // All nodes are pre-allocated so iteration order does not affect correctness;
    // any node referenced as a dependency already exists in `populated`.
    for (const scc of sccs) {
      for (const id of scc) {
        const flat = dbMap.get(id)!;
        const node = populated.get(id)!;
        for (const depId of flat.dependencies) {
          node.dependencies.push(populated.get(depId)!);
        }
      }
    }

    return flatDatabaseState.map((c) => populated.get(c.id)!);
  },
};
