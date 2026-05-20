import { assertNoExtraQueries, classifySerializationFailure, smartCheck } from './shared';

export async function typeormProbe(repo: any, dataSource: any) {
  const expectedAdj = { a: ['b'], b: ['a'] };
  let queryCount = 0;
  dataSource.logger.logQuery = () => {
    queryCount++;
  };

  const roots = await repo.find({ relations: { dependencies: { dependencies: true } } });
  const afterInitialFetch = queryCount;

  roots.forEach((r: any) => r.dependencies.forEach((d: any) => d.dependencies.length));
  const queryGate = assertNoExtraQueries(afterInitialFetch, queryCount);
  const graphCheck = smartCheck(roots, expectedAdj);

  let serialization = 'SERIALIZE_PASS';
  try {
    JSON.stringify(roots);
  } catch (e) {
    serialization = classifySerializationFailure(e);
  }

  const hydrationPass = queryGate.pass && graphCheck.pass;
  return { hydration: hydrationPass ? 'HYDRATION PASS' : 'HYDRATION FAIL', queryGate, graphCheck, serialization };
}
