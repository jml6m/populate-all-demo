import { Collection, EntitySchema, MikroORM } from '@mikro-orm/core';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { finalizeSerialization, smartCheck } from './ts/shared';
import { PROBE_IDENTITIES } from './ts/probe-config';
import { formatErrorDetail, getNodePackageVersion, writeProbeResult } from './ts/result-builder';

class Node {
  id!: string;
  dependencies = new Collection<Node>(this);
  dependents = new Collection<Node>(this);
}

const NodeSchema = new EntitySchema<Node>({
  class: Node,
  properties: {
    id: { type: 'string', primary: true },
    dependencies: {
      kind: 'm:n',
      entity: () => Node,
      owner: true,
      pivotTable: 'node_dependencies',
      inversedBy: 'dependents',
    },
    dependents: {
      kind: 'm:n',
      entity: () => Node,
      mappedBy: 'dependencies',
    },
  },
});

async function run() {
  let queryCount = 0;
  const expectedAdj = { a: ['b'], b: ['a'] };
  const findings: {
    hydration: { result: 'PASS' | 'FAIL'; detail: string };
    queryGate: { result: 'PASS' | 'FAIL' | 'NOT_APPLICABLE'; detail: string; extraQueries?: number };
    smartCheck: { result: 'PASS' | 'FAIL'; detail: string };
    serialize: { result: 'SERIALIZE_PASS' | 'SERIALIZE_FAIL_CYCLE' | 'SERIALIZE_FAIL_OTHER'; detail: string };
  } = {
    hydration: { result: 'FAIL', detail: '' },
    queryGate: { result: 'FAIL', detail: '' },
    smartCheck: { result: 'FAIL', detail: '' },
    serialize: { result: 'SERIALIZE_FAIL_OTHER', detail: '' },
  };

  const orm = await MikroORM.init<SqliteDriver>({
    driver: SqliteDriver,
    entities: [NodeSchema],
    dbName: ':memory:',
    allowGlobalContext: true,
    debug: ['query'],
    logger: (message) => {
      if (message.toLowerCase().includes('select') || message.toLowerCase().includes('insert') || message.toLowerCase().includes('update')) {
        queryCount += 1;
      }
      console.log(message);
    },
  });

  try {
    await orm.schema.refreshDatabase();

    const a = new Node();
    a.id = 'a';
    const b = new Node();
    b.id = 'b';

    a.dependencies.add(b);
    b.dependencies.add(a);

    await orm.em.persistAndFlush([a, b]);
    orm.em.clear();

    const roots = await orm.em.find(Node, { id: { $in: ['a', 'b'] } }, { populate: ['dependencies.dependencies'], orderBy: { id: 'asc' } });

    const queriesAfterHydration = queryCount;

    for (const root of roots) {
      for (const dep of root.dependencies.getItems()) {
        void dep.dependencies.getItems().length;
      }
    }

    const extraQueries = queryCount - queriesAfterHydration;
    findings.queryGate =
      extraQueries === 0
        ? { result: 'PASS', detail: 'No additional queries observed during traversal.' }
        : { result: 'FAIL', extraQueries, detail: `Expected 0 additional queries during traversal, observed ${extraQueries}.` };

    const graphCheck = smartCheck(roots as Node[], expectedAdj, {
      getId: (node) => node.id,
      getDeps: (node): Node[] => node.dependencies.getItems(),
    });
    findings.smartCheck = graphCheck.pass
      ? { result: 'PASS', detail: 'Identity and dependency closure checks passed.' }
      : { result: 'FAIL', detail: graphCheck.reason ?? 'Identity/closure check failed.' };

    findings.hydration =
      findings.queryGate.result === 'PASS' && findings.smartCheck.result === 'PASS'
        ? { result: 'PASS', detail: 'Hydration check passed.' }
        : {
            result: 'FAIL',
            detail: `Hydration failed: queryGate=${findings.queryGate.result}, smartCheck=${findings.smartCheck.result}.`,
          };

    const serialization = finalizeSerialization(() => JSON.stringify(roots));
    findings.serialize =
      serialization === 'SERIALIZE_PASS'
        ? { result: serialization, detail: 'JSON serialization passed.' }
        : { result: serialization, detail: `JSON serialization failed with ${serialization}.` };

    const outputPath = writeProbeResult({
      ...PROBE_IDENTITIES.mikroorm,
      libraryVersion: getNodePackageVersion('@mikro-orm/core'),
      runtimeVersion: process.version,
      findings,
    });

    console.log('mikroorm-test');
    console.log('hydration:', findings.hydration.result === 'PASS' ? 'HYDRATION PASS' : 'HYDRATION FAIL');
    console.log('queryGate:', findings.queryGate);
    console.log('smartCheck:', findings.smartCheck);
    console.log('serialization:', findings.serialize.result);
    console.log('json:', outputPath);
  } catch (error) {
    const detail = formatErrorDetail(error);
    findings.hydration = { result: 'FAIL', detail };
    findings.queryGate = { result: 'FAIL', detail };
    findings.smartCheck = { result: 'FAIL', detail };
    findings.serialize = { result: 'SERIALIZE_FAIL_OTHER', detail };

    writeProbeResult({
      ...PROBE_IDENTITIES.mikroorm,
      libraryVersion: getNodePackageVersion('@mikro-orm/core'),
      runtimeVersion: process.version,
      findings,
    });

    console.error('mikroorm-test failed:', error);
    process.exitCode = 1;
  } finally {
    await orm.close(true);
  }
}

void run();
