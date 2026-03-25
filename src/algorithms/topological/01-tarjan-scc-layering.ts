import { ComponentFlat, ComponentPopulated, PopulateAlgorithm } from '../types';

export const tarjanSccLayering: PopulateAlgorithm = {
  name: 'Tarjan SCC Layering',
  category: 'Topological',
  timeComplexity: 'O(V + E)',
  spaceComplexity: 'O(V)',
  description:
    "Uses iterative Tarjan's SCC algorithm to find all strongly connected components, condenses them into a DAG, then uses Kahn's BFS to assign each SCC to a layer. Dependencies are wired layer-by-layer (leaves first). All nodes are pre-allocated before wiring so intra-SCC cycles share the same object reference.",
  execute: (flatDatabaseState: ComponentFlat[]): ComponentPopulated[] => {
    const dbMap = new Map<string, ComponentFlat>();
    for (const comp of flatDatabaseState) {
      dbMap.set(comp.id, comp);
    }

    // Validate all dependencies exist before running Tarjan's
    for (const comp of flatDatabaseState) {
      for (const depId of comp.dependencies) {
        if (!dbMap.has(depId)) {
          throw new Error(`Component ${comp.id} has dependency ${depId} which does not exist`);
        }
      }
    }

    // --- Step 1: Iterative Tarjan's SCC ---
    // Produces `sccs` in reverse topological order of the condensation DAG (sinks first).
    const index = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Map<string, boolean>();
    const stack: string[] = [];
    const sccOf = new Map<string, number>(); // node id → index in sccs[]
    const sccs: string[][] = [];
    let counter = 0;

    function strongconnectIterative(startId: string): void {
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
          callStack.pop();
          if (callStack.length > 0) {
            const parent = callStack[callStack.length - 1];
            lowlink.set(parent.id, Math.min(lowlink.get(parent.id)!, lowlink.get(frame.id)!));
          }
          if (lowlink.get(frame.id) === index.get(frame.id)) {
            const scc: string[] = [];
            let w: string;
            do {
              w = stack.pop()!;
              onStack.set(w, false);
              scc.push(w);
              sccOf.set(w, sccs.length);
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

    // --- Step 2: Build condensation DAG ---
    // condensedChildren[i] = distinct SCC indices that SCC i has outgoing edges to (SCC i depends on them)
    // condensedParents[j]   = SCC indices that have edges pointing into j (they depend on j)
    // outDegree[i]          = number of distinct SCCs that SCC i externally depends on
    const numSccs = sccs.length;
    const condensedChildren: Set<number>[] = Array.from({ length: numSccs }, () => new Set<number>());
    const condensedParents: number[][] = Array.from({ length: numSccs }, () => []);
    const outDegree = new Array<number>(numSccs).fill(0);

    for (const comp of flatDatabaseState) {
      const fromScc = sccOf.get(comp.id)!;
      for (const depId of comp.dependencies) {
        const toScc = sccOf.get(depId)!;
        if (fromScc !== toScc && !condensedChildren[fromScc].has(toScc)) {
          condensedChildren[fromScc].add(toScc);
          condensedParents[toScc].push(fromScc);
          outDegree[fromScc]++;
        }
      }
    }

    // --- Step 3: Kahn's BFS to assign condensation layers ---
    // Layer 0 = SCCs with no external dependencies (leaf/sink SCCs in condensed DAG).
    // Layer N = SCCs whose all external dependencies fall in layers 0..N-1.
    const layers: number[][] = [];
    const remaining = [...outDegree];
    let frontier: number[] = [];
    for (let i = 0; i < numSccs; i++) {
      if (remaining[i] === 0) frontier.push(i);
    }
    while (frontier.length > 0) {
      layers.push(frontier);
      const next: number[] = [];
      for (const sccIdx of frontier) {
        for (const parentScc of condensedParents[sccIdx]) {
          remaining[parentScc]--;
          if (remaining[parentScc] === 0) next.push(parentScc);
        }
      }
      frontier = next;
    }

    // --- Step 4: Pre-allocate all ComponentPopulated nodes ---
    // All nodes exist before any wiring so intra-SCC cycles resolve to the same object reference.
    const populated = new Map<string, ComponentPopulated>();
    for (const comp of flatDatabaseState) {
      populated.set(comp.id, { id: comp.id, dependencies: [] });
    }

    // --- Step 5: Wire dependencies layer by layer ---
    // Each layer processes all SCCs at the same depth in the condensation DAG.
    for (const layer of layers) {
      for (const sccIdx of layer) {
        for (const id of sccs[sccIdx]) {
          const flat = dbMap.get(id)!;
          const node = populated.get(id)!;
          for (const depId of flat.dependencies) {
            node.dependencies.push(populated.get(depId)!);
          }
        }
      }
    }

    return flatDatabaseState.map((c) => populated.get(c.id)!);
  },
};
