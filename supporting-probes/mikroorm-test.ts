import { Collection, EntitySchema, MikroORM } from '@mikro-orm/core';
import { SqliteDriver } from '@mikro-orm/sqlite';
import { finalizeSerialization, smartCheck } from './ts/shared';

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

  const orm = await MikroORM.init<SqliteDriver>({
    entities: [NodeSchema],
    dbName: ':memory:',
    debug: ['query'],
    logger: (message) => {
      if (message.toLowerCase().includes('select') || message.toLowerCase().includes('insert') || message.toLowerCase().includes('update')) {
        queryCount += 1;
      }
      console.log(message);
    },
  });

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

  const queryGate =
    queryCount === queriesAfterHydration
      ? { pass: true, reason: null }
      : { pass: false, reason: `expected no additional queries during traversal, saw +${queryCount - queriesAfterHydration}` };
  const graphCheck = smartCheck(roots, expectedAdj, {
    getId: (node) => node.id,
    getDeps: (node) => node.dependencies.getItems(),
  });
  const hydration = queryGate.pass && graphCheck.pass ? 'HYDRATION PASS' : 'HYDRATION FAIL';

  const serialization = finalizeSerialization(() => JSON.stringify(roots));

  console.log('mikroorm-test');
  console.log('hydration:', hydration);
  console.log('queryGate:', queryGate);
  console.log('smartCheck:', graphCheck);
  console.log('serialization:', serialization);

  await orm.close(true);
}

run().catch((error) => {
  console.error('mikroorm-test failed:', error);
  process.exitCode = 1;
});
