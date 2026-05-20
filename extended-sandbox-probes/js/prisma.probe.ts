import { assertNoExtraQueries, classifySerializationFailure, smartCheck } from './shared';

export async function prismaProbe(prisma: any) {
  const expectedAdj = { a: ['b'], b: ['a'] };
  let queryCount = 0;
  prisma.$on('query', () => {
    queryCount++;
  });

  const roots = await prisma.node.findMany({
    include: { dependencies: { include: { dependencies: true } } },
  });
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
