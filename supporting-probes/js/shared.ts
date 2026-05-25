export type SerializationResult = 'SERIALIZE_PASS' | 'SERIALIZE_FAIL_CYCLE' | 'SERIALIZE_FAIL_OTHER';

export interface SmartCheckResult {
  pass: boolean;
  reason: string | null;
  uniqueIds: number;
  uniqueInstances: number;
  edgesTraversed: number;
}

export function classifySerializationError(error: unknown): SerializationResult {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  const normalized = msg.toLowerCase();
  if (normalized.includes('cycle') || normalized.includes('circular') || normalized.includes('converting circular structure')) {
    return 'SERIALIZE_FAIL_CYCLE';
  }
  return 'SERIALIZE_FAIL_OTHER';
}

export function assertNoExtraQueries(beforeTraversal: number, afterTraversal: number): { pass: boolean; reason: string | null } {
  if (afterTraversal === beforeTraversal) return { pass: true, reason: null };
  return { pass: false, reason: `expected no additional queries during traversal, saw +${afterTraversal - beforeTraversal}` };
}

export function smartCheck<T>(
  roots: T[],
  expectedAdj: Record<string, string[]>,
  ops: { getId(node: T): string; getDeps(node: T): T[] }
): SmartCheckResult {
  const visited = new Set<T>();
  const byId = new Map<string, T>();
  const stack = [...roots];
  let edgesTraversed = 0;

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);

    const id = ops.getId(node);
    const prior = byId.get(id);
    if (prior !== undefined && prior !== node) {
      return {
        pass: false,
        reason: `id "${id}" maps to multiple in-memory instances`,
        uniqueIds: byId.size,
        uniqueInstances: visited.size,
        edgesTraversed,
      };
    }
    byId.set(id, node);

    const expected = new Set(expectedAdj[id] ?? []);
    const deps = ops.getDeps(node);
    const actual = new Set(deps.map((d) => ops.getId(d)));
    if (actual.size !== expected.size || [...actual].some((depId) => !expected.has(depId))) {
      return {
        pass: false,
        reason: `dependency closure mismatch at "${id}"`,
        uniqueIds: byId.size,
        uniqueInstances: visited.size,
        edgesTraversed,
      };
    }

    for (const dep of deps) {
      edgesTraversed += 1;
      stack.push(dep);
    }
  }

  if (byId.size !== Object.keys(expectedAdj).length) {
    return {
      pass: false,
      reason: `reachable ids mismatch: got ${byId.size}, expected ${Object.keys(expectedAdj).length}`,
      uniqueIds: byId.size,
      uniqueInstances: visited.size,
      edgesTraversed,
    };
  }

  return { pass: true, reason: null, uniqueIds: byId.size, uniqueInstances: visited.size, edgesTraversed };
}

export function finalizeSerialization(run: () => unknown): SerializationResult {
  try {
    run();
    return 'SERIALIZE_PASS';
  } catch (error) {
    return classifySerializationError(error);
  }
}
