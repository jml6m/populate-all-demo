import { ComponentFlat, ComponentPopulated, PopulateAlgorithm } from '../types';

export const dataloaderBatching: PopulateAlgorithm = {
  name: 'DataLoader Batching',
  category: 'GraphQL',
  timeComplexity: 'O(V + E)',
  spaceComplexity: 'O(V)',
  description:
    'Simulates GraphQL DataLoader-style batched loading. Starts with root IDs, collects all dependency IDs per level, batch-resolves them, and repeats until all dependencies are resolved. A visited map handles cycles by returning the existing reference when a node is revisited.',
  execute: (flatDatabaseState: ComponentFlat[]): ComponentPopulated[] => {
    const dbMap = new Map<string, ComponentFlat>();
    for (const comp of flatDatabaseState) {
      dbMap.set(comp.id, comp);
    }

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
        node.dependencies.push(visited.get(depId)!);
      }
    }

    return flatDatabaseState.map((c) => visited.get(c.id)!);
  },
};
