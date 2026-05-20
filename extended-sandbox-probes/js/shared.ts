export type SerializationLabel = 'SERIALIZE_PASS' | 'SERIALIZE_FAIL_CYCLE' | 'SERIALIZE_FAIL_OTHER';

export interface SmartCheckResult {
  pass: boolean;
  reason: string | null;
  uniqueIds: number;
  uniqueInstances: number;
  edges: number;
}

export function classifySerializationFailure(error: unknown): SerializationLabel {
  if (error === null || error === undefined) return 'SERIALIZE_PASS';
  const message = error instanceof Error ? error.message : String(error);
  const m = message.toLowerCase();
  if (m.includes('circular') || m.includes('cycle') || m.includes('converting circular structure')) {
    return 'SERIALIZE_FAIL_CYCLE';
  }
  return 'SERIALIZE_FAIL_OTHER';
}

export function smartCheck<T extends { id: string; dependencies: T[] }>(roots: T[], expectedAdj: Record<string, string[]>): SmartCheckResult {
  const stack = [...roots];
  const visited = new Set<T>();
  const byId = new Map<string, T>();
  let edges = 0;

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (visited.has(node)) continue;
    visited.add(node);

    const prior = byId.get(node.id);
    if (prior !== undefined && prior !== node) {
      return { pass: false, reason: `id ${node.id} resolved to multiple instances`, uniqueIds: byId.size, uniqueInstances: visited.size, edges };
    }
    byId.set(node.id, node);

    const actualDeps = new Set(node.dependencies.map((d) => d.id));
    const expectedDeps = new Set(expectedAdj[node.id] ?? []);
    if (actualDeps.size !== expectedDeps.size || [...actualDeps].some((id) => !expectedDeps.has(id))) {
      return { pass: false, reason: `closure mismatch at ${node.id}`, uniqueIds: byId.size, uniqueInstances: visited.size, edges };
    }

    for (const dep of node.dependencies) {
      edges++;
      stack.push(dep);
    }
  }

  if (Object.keys(expectedAdj).length !== byId.size) {
    return {
      pass: false,
      reason: `reachable ids ${byId.size}/${Object.keys(expectedAdj).length}`,
      uniqueIds: byId.size,
      uniqueInstances: visited.size,
      edges,
    };
  }

  return { pass: true, reason: null, uniqueIds: byId.size, uniqueInstances: visited.size, edges };
}

export function assertNoExtraQueries(startCount: number, endCount: number): { pass: boolean; reason: string | null } {
  if (endCount !== startCount) return { pass: false, reason: `unexpected queries during traversal: +${endCount - startCount}` };
  return { pass: true, reason: null };
}
