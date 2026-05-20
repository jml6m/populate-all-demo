import { assertNoExtraQueries, classifySerializationFailure, smartCheck } from './shared';

// Supporting probe only. Run externally.
export async function mikroOrmProbe(em: any) {
  const expectedAdj = { a: ['b'], b: ['a'] };
  let queryCount = 0;
  // Example instrumentation: configure MikroORM logger callback and increment queryCount.

  // 1) Initial eager load.
  const roots = await em.find('Node', {}, { populate: ['dependencies', 'dependencies.dependencies'] });
  const afterInitialFetch = queryCount;

  // 2) Deep traversal (should not trigger new queries if fully hydrated).
  roots.forEach((r: any) => r.dependencies.forEach((d: any) => d.dependencies.length));
  const queryGate = assertNoExtraQueries(afterInitialFetch, queryCount);

  // 3) Runtime identity/closure smart check.
  const graphCheck = smartCheck(roots, expectedAdj);

  // 4) Serialization classification (separate from hydration).
  let serialization = 'SERIALIZE_PASS';
  try {
    JSON.stringify(roots);
  } catch (e) {
    serialization = classifySerializationFailure(e);
  }

  const hydrationPass = queryGate.pass && graphCheck.pass;
  return { hydration: hydrationPass ? 'HYDRATION PASS' : 'HYDRATION FAIL', queryGate, graphCheck, serialization };
}
