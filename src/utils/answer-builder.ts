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
      if (!Number.isInteger(depIdx) || depIdx < 0 || depIdx >= nodes.length) {
        throw new Error(
          `Invalid dependency index ${depIdx} for entry at index ${i} (id: "${entries[i].id}"): must be an integer in [0, ${nodes.length - 1}]`
        );
      }
      nodes[i].dependencies.push(nodes[depIdx]);
    }
  }
  return nodes;
}
