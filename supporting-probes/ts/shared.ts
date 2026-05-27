export type SerializationResult = 'SERIALIZE_PASS' | 'SERIALIZE_FAIL_CYCLE' | 'SERIALIZE_FAIL_OTHER';

export interface SmartCheckResult {
  pass: boolean;
  reason: string | null;
  uniqueIds: number;
  uniqueInstances: number;
  edgesTraversed: number;
}

function isCycleSerializationError(error: unknown): boolean {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || current === null || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof Error) {
      const normalized = current.message.toLowerCase();
      if (current.name === 'TypeError' && (normalized.includes('circular') || normalized.includes('cyclic') || normalized.includes('cycle'))) {
        return true;
      }
      queue.push((current as Error & { cause?: unknown }).cause);
    }
  }
  return false;
}

export function classifySerializationError(error: unknown): SerializationResult {
  if (isCycleSerializationError(error)) {
    return 'SERIALIZE_FAIL_CYCLE';
  }
  return 'SERIALIZE_FAIL_OTHER';
}

/**
 * Smart hydration validation for supporting probes.
 *
 * Verifies runtime identity and dependency closure against an expected adjacency
 * map while traversing only reachable nodes from roots.
 */
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
