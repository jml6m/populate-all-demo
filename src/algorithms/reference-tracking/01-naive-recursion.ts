import { PopulateAlgorithm, ComponentFlat, ComponentPopulated } from '../types';

export const naiveRecursion: PopulateAlgorithm = {
  name: "Naive Recursion",
  category: "Reference Tracking",
  timeComplexity: "O(∞)",
  spaceComplexity: "O(∞)",
  description: "Standard recursive population without cycle tracking. Will cause a stack overflow on cyclic graphs.",
  execute: (flatDatabaseState: ComponentFlat[]): ComponentPopulated[] => {
    const dbMap = new Map<string, ComponentFlat>();
    for (const comp of flatDatabaseState) {
      dbMap.set(comp.id, comp);
    }

    function populate(id: string): ComponentPopulated {
      const flat = dbMap.get(id);
      if (!flat) throw new Error(`Component ${id} not found`);

      const populated: ComponentPopulated = {
        id: flat.id,
        name: flat.name,
        dependencies:[]
      };

      for (const depId of flat.dependencies) {
        populated.dependencies.push(populate(depId));
      }

      return populated;
    }

    return flatDatabaseState.map(comp => populate(comp.id));
  }
};
