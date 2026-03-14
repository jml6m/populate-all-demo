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

// The answer format stores dependency positions (array indices) instead of string IDs.
// This flat index-based structure avoids deep YAML nesting for large cyclic graphs
// while still encoding the exact same graph topology as the input.
// At load time, the runner rebuilds the cyclic ComponentPopulated[] from these indices.
export interface AnswerEntry {
  id: string;
  name: string;
  depIndices: number[];
}

export interface PopulateAlgorithm {
  name: string;
  category: 'Reference Tracking' | 'Schema-Driven' | 'Topological';
  timeComplexity: string;
  spaceComplexity: string;
  description: string;
  execute: (flatDatabaseState: ComponentFlat[]) => ComponentPopulated[];
}
