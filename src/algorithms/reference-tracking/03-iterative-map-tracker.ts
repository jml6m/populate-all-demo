import { PopulateAlgorithm, ComponentFlat, ComponentPopulated } from '../types';

export const iterativeMapTracker: PopulateAlgorithm = {
  name: 'Iterative Map Tracker',
  category: 'Reference Tracking',
  timeComplexity: 'O(V + E)',
  spaceComplexity: 'O(V)',
  description:
    'Iterative variant of Map Tracker: converts the recursive DFS to an explicit frame stack, eliminating the call-stack depth limit. Pre-allocates each node shell before pushing its frame so back-edges always resolve to the same JS object — no cycle guard needed beyond the visited map.',
  execute: (flatDatabaseState: ComponentFlat[]): ComponentPopulated[] => {
    const dbMap = new Map<string, ComponentFlat>();
    for (const comp of flatDatabaseState) {
      dbMap.set(comp.id, comp);
    }

    const visited = new Map<string, ComponentPopulated>();

    // Iterative DFS — each frame records the node id and the next dependency
    // index to process.  A shell is pre-allocated and registered in `visited`
    // before the frame is pushed, so any back-edge to this node during DFS
    // resolves to the same JS object reference (same as the recursive version).
    interface Frame {
      id: string;
      depIdx: number;
    }

    for (const root of flatDatabaseState) {
      if (visited.has(root.id)) continue;

      // Allocate shell for root before the first frame is pushed.
      visited.set(root.id, { id: root.id, dependencies: [] });

      const stack: Frame[] = [{ id: root.id, depIdx: 0 }];

      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        const flat = dbMap.get(frame.id)!;

        if (frame.depIdx >= flat.dependencies.length) {
          stack.pop();
          continue;
        }

        const depId = flat.dependencies[frame.depIdx];
        frame.depIdx++;

        // Wire the dependency to the current node immediately.  The shell
        // object for depId already exists (or will be created just below),
        // so the reference is stable regardless of whether depId is new or
        // a back-edge to an in-progress ancestor.
        const currentNode = visited.get(frame.id)!;

        if (!visited.has(depId)) {
          const flat2 = dbMap.get(depId);
          if (!flat2) throw new Error(`Component ${depId} not found`);
          // Allocate shell before pushing so intra-subtree cycles find it.
          visited.set(depId, { id: depId, dependencies: [] });
          stack.push({ id: depId, depIdx: 0 });
        }

        currentNode.dependencies.push(visited.get(depId)!);
      }
    }

    return flatDatabaseState.map((comp) => visited.get(comp.id)!);
  },
};
