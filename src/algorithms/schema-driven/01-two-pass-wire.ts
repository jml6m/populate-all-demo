import { ComponentFlat, ComponentPopulated, PopulateAlgorithm } from '../types';

export const twoPassWire: PopulateAlgorithm = {
  name: 'Two-Pass Wire',
  category: 'Schema-Driven',
  timeComplexity: 'O(V + E)',
  spaceComplexity: 'O(V)',
  description:
    'Pre-allocates all node shells in a first pass, then wires dependency edges in a second pass. Each node is allocated exactly once, so intra-cycle references naturally resolve to the same JS object — no explicit cycle guard needed.',
  execute: (flatDatabaseState: ComponentFlat[]): ComponentPopulated[] => {
    // Pre-allocate all ComponentPopulated shells so every reference to the same
    // id points to the same JS object — this is what makes cycles cycle-safe.
    const visited = new Map<string, ComponentPopulated>();
    for (const comp of flatDatabaseState) {
      visited.set(comp.id, { id: comp.id, name: comp.name, dependencies: [] });
    }

    // Wire up dependencies in a single pass — each node is resolved exactly
    // once and every subsequent reference reuses the existing object.
    for (const comp of flatDatabaseState) {
      const node = visited.get(comp.id)!;
      for (const depId of comp.dependencies) {
        const depNode = visited.get(depId);
        if (!depNode) {
          throw new Error(`Component ${depId} not found`);
        }
        node.dependencies.push(depNode);
      }
    }

    return flatDatabaseState.map((c) => visited.get(c.id)!);
  },
};
