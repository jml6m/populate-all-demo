import { PopulateAlgorithm, ComponentFlat, ComponentPopulated } from '../types';

export const mapTracker: PopulateAlgorithm = {
  name: "Map Tracker",
  category: "Reference Tracking",
  timeComplexity: "O(V + E)",
  spaceComplexity: "O(V)",
  description: "Uses a Map to track visited nodes during graph traversal to safely close cycles in RAM.",
  execute: (flatDatabaseState: ComponentFlat[]): ComponentPopulated[] => {
    const dbMap = new Map<string, ComponentFlat>();
    for (const comp of flatDatabaseState) {
      dbMap.set(comp.id, comp);
    }

    const visited = new Map<string, ComponentPopulated>();

    function populate(id: string): ComponentPopulated {
      if (visited.has(id)) {
        return visited.get(id)!;
      }

      const flat = dbMap.get(id);
      if (!flat) throw new Error(`Component ${id} not found`);

      const populated: ComponentPopulated = {
        id: flat.id,
        name: flat.name,
        dependencies: []
      };

      visited.set(id, populated);

      for (const depId of flat.dependencies) {
        populated.dependencies.push(populate(depId));
      }

      return populated;
    }

    return flatDatabaseState.map(comp => populate(comp.id));
  }
};
