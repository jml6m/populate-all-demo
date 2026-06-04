import { AnswerEntry, ComponentPopulated } from '../algorithms/types';

export interface FlatCompareResult {
  pass: boolean;
  errorDetail: string | null;
}

/**
 * Independent accuracy verifier — does NOT use smartCompare or buildPopulatedFromAnswer.
 *
 * Flattens the algorithm's output back to an index-based representation and
 * compares it directly against the raw AnswerEntry[] loaded from the answer
 * YAML file.  Any bug that affects both buildPopulatedFromAnswer AND the
 * algorithm will be invisible to smartCompare (both sides carry the same bug),
 * but flatCompare will still catch it because it compares against the raw file.
 *
 * Steps:
 *  1. Validate lengths
 *  2. Build an identity map: ComponentPopulated object → top-level index
 *  3. Flatten actual to {id, depIndices} using the identity map
 *  4. Compare entry-by-entry against rawAnswerEntries (sorted dep indices)
 */
export function flatCompare(actual: ComponentPopulated[], rawAnswerEntries: AnswerEntry[]): FlatCompareResult {
  if (!Array.isArray(actual) || !Array.isArray(rawAnswerEntries)) {
    return { pass: false, errorDetail: 'Both actual and rawAnswerEntries must be arrays' };
  }

  if (actual.length !== rawAnswerEntries.length) {
    return {
      pass: false,
      errorDetail: `Length mismatch: actual=${actual.length}, rawAnswerEntries=${rawAnswerEntries.length}`,
    };
  }

  // Build identity map: each top-level node object → its index in the actual array
  const identityMap = new Map<ComponentPopulated, number>();
  for (let i = 0; i < actual.length; i++) {
    identityMap.set(actual[i]!, i);
  }

  for (let i = 0; i < actual.length; i++) {
    const node = actual[i]!;
    const entry = rawAnswerEntries[i]!;

    if (node.id !== entry.id) {
      return { pass: false, errorDetail: `id mismatch at index ${i}: actual="${node.id}", expected="${entry.id}"` };
    }

    // Resolve each dependency to its index via the identity map
    const actualDepIndices: number[] = [];
    for (const dep of node.dependencies) {
      const idx = identityMap.get(dep);
      if (idx === undefined) {
        return {
          pass: false,
          errorDetail: `Dependency of node "${node.id}" at index ${i} is not present in the top-level actual array`,
        };
      }
      actualDepIndices.push(idx);
    }

    // Sort both sides before comparing so order differences don't cause false failures
    const sortedActual = [...actualDepIndices].sort((a, b) => a - b);
    const sortedExpected = [...entry.depIndices].sort((a, b) => a - b);

    if (sortedActual.length !== sortedExpected.length) {
      return {
        pass: false,
        errorDetail: `dep count mismatch at index ${i} (id="${node.id}"): actual=${sortedActual.length}, expected=${sortedExpected.length}`,
      };
    }

    for (let j = 0; j < sortedActual.length; j++) {
      if (sortedActual[j] !== sortedExpected[j]) {
        return {
          pass: false,
          errorDetail: `dep mismatch at index ${i} (id="${node.id}"): actual depIndices=${JSON.stringify(sortedActual)}, expected=${JSON.stringify(sortedExpected)}`,
        };
      }
    }
  }

  return { pass: true, errorDetail: null };
}
