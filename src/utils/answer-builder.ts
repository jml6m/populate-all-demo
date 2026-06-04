import { AnswerEntry, ComponentPopulated } from '../algorithms/types';

/**
 * Rebuilds a ComponentPopulated[] with proper JS object identity (for cycles) from
 * the flat index-based answer format stored in the answer YAML file.
 *
 * Two-pass approach:
 *  Pass 1 — Create all node shells (empty dependencies array)
 *  Pass 2 — Wire dependencies using index lookups so cycles share the same JS object
 *
 * @param verbose When true, prints a step-by-step wiring trace to stdout.
 */
export function buildPopulatedFromAnswer(entries: AnswerEntry[], verbose = false): ComponentPopulated[] {
  if (verbose) {
    console.log('\n--- Pass 1: Shell creation ---');
    for (const e of entries) {
      console.log(`Shell: ${e.id} (deps: [${e.depIndices.join(', ')}])`);
    }
  }

  const nodes: ComponentPopulated[] = entries.map((e) => ({ id: e.id, dependencies: [] }));

  if (verbose) {
    console.log('\n--- Pass 2: Wiring ---');
  }

  for (let i = 0; i < entries.length; i++) {
    if (verbose) {
      console.log(`\n${nodes[i]!.id}:`);
      if (entries[i]!.depIndices.length === 0) {
        console.log('  (no dependencies)');
      }
    }
    for (const depIdx of entries[i]!.depIndices) {
      if (!Number.isInteger(depIdx) || depIdx < 0 || depIdx >= nodes.length) {
        throw new Error(`Invalid dependency index ${depIdx} for entry at index ${i} (id: "${entries[i]!.id}"): must be an integer in [0, ${nodes.length - 1}]`);
      }
      nodes[i]!.dependencies.push(nodes[depIdx]!);
      if (verbose) {
        console.log(`  Wire: ${nodes[i]!.id}.dependencies[${nodes[i]!.dependencies.length - 1}] → ${nodes[depIdx]!.id} (index ${depIdx})`);
      }
    }
  }

  if (verbose) {
    console.log('\n--- Identity checks ---');
    for (let i = 0; i < entries.length; i++) {
      for (let j = 0; j < entries[i]!.depIndices.length; j++) {
        const depIdx = entries[i]!.depIndices[j]!;
        const isSame = nodes[i]!.dependencies[j] === nodes[depIdx]!;
        console.log(`Identity check: nodes[${i}].dependencies[${j}] === nodes[${depIdx}] → ${isSame}`);
      }
    }

    console.log('\n--- Final expected graph ---');
    for (const node of nodes) {
      const depIds = node.dependencies.map((d) => d.id).join(', ');
      console.log(`${node.id} → [${depIds}]`);
    }
  }

  return nodes;
}
