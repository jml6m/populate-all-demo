import { assertNoExtraQueries, classifySerializationFailure, smartCheck } from './shared';

export async function sequelizeProbe(Node: any, sequelize: any) {
  const expectedAdj = { a: ['b'], b: ['a'] };
  let queryCount = 0;
  sequelize.options.logging = () => {
    queryCount++;
  };

  const roots = await Node.findAll({
    include: [{ association: 'dependencies', include: [{ association: 'dependencies' }] }],
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
