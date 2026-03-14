export interface ComponentFlat {
  id: string;
  name: string;
  dependencies: string[];
}

export interface ComponentPopulated {
  id: string;
  name: string;
  dependencies: ComponentPopulated[];
}

export interface PopulateAlgorithm {
  name: string;
  category: 'Reference Tracking' | 'Schema-Driven' | 'Topological';
  timeComplexity: string;
  spaceComplexity: string;
  description: string;
  execute: (flatDatabaseState: ComponentFlat[]) => ComponentPopulated[];
}
