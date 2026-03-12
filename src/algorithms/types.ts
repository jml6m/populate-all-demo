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
  category: 'Cycle Detection' | 'GraphQL' | 'DDD' | 'Topological';
  timeComplexity: string;
  spaceComplexity: string;
  description: string;
  execute: (flatDatabaseState: ComponentFlat[]) => ComponentPopulated[];
}
