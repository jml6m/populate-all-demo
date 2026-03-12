import { ComponentFlat, ComponentPopulated, PopulateAlgorithm } from '../types';

export const dataloaderBatching: PopulateAlgorithm = {
  name: 'DataLoader Batching',
  category: 'GraphQL',
  timeComplexity: 'O(V + E)',
  spaceComplexity: 'O(V)',
  description:
    'Simulates GraphQL DataLoader-style batched loading using a single global batch. All node shells are pre-allocated up front, then their dependency edges are wired in one pass so each node is resolved exactly once. A visited map handles cycles and shared references by returning the existing object when a node is revisited.',
  execute: (flatDatabaseState: ComponentFlat[]): ComponentPopulated[] => {
    // Pre-allocate all ComponentPopulated shells so every reference to the same
    // id points to the same JS object — this is what makes cycles cycle-safe.
    const visited = new Map<string, ComponentPopulated>();
    for (const comp of flatDatabaseState) {
      visited.set(comp.id, { id: comp.id, name: comp.name, dependencies: [] });
    }

    // Wire up dependencies in a single pass — equivalent to one "batch resolve"
    // per node (all resolved in a single level because we pre-allocated everything).
    // This correctly mirrors the DataLoader pattern: each node is resolved exactly
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
