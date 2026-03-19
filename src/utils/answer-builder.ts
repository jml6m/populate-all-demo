import { AnswerEntry, ComponentPopulated } from '../algorithms/types';

/**
 * Rebuilds a ComponentPopulated[] with proper JS object identity (for cycles) from
 * the flat index-based answer format stored in the answer YAML file.
 *
 * Two-pass approach:
 *  Pass 1 — Create all node shells (empty dependencies array)
 *  Pass 2 — Wire dependencies using index lookups so cycles share the same JS object
 */
export function buildPopulatedFromAnswer(entries: AnswerEntry[]): ComponentPopulated[] {
  const nodes: ComponentPopulated[] = entries.map((e) => ({ id: e.id, dependencies: [] }));
  for (let i = 0; i < entries.length; i++) {
    for (const depIdx of entries[i].depIndices) {
      nodes[i].dependencies.push(nodes[depIdx]);
    }
  }
  return nodes;
}
