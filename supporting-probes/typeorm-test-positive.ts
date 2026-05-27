import 'reflect-metadata';
import { DataSource, EntitySchema, Logger } from 'typeorm';
import { finalizeSerialization, smartCheck } from './ts/shared';

type Node = {
  id: number;
  name: string;
  dependencies: Node[];
  dependents: Node[];
};

const NodeSchema = new EntitySchema<Node>({
  name: 'Node',
  tableName: 'nodes',
  columns: {
    id: { type: Number, primary: true, generated: true },
    name: { type: String, unique: true },
  },
  relations: {
    dependencies: {
      type: 'many-to-many',
      target: 'Node',
      joinTable: { name: 'node_dependencies' },
      inverseSide: 'dependents',
      cascade: true,
    },
    dependents: {
      type: 'many-to-many',
      target: 'Node',
      mappedBy: 'dependencies',
    },
  },
});

class QueryCounterLogger implements Logger {
  public queryCount = 0;
  logQuery(): void {
    this.queryCount += 1;
  }
  logQueryError(): void {}
  logQuerySlow(): void {}
  logSchemaBuild(): void {}
  logMigration(): void {}
  log(): void {}
}

function toCycleSafeProjection(roots: Node[]) {
  return roots.map((node) => ({ id: node.name, depIds: node.dependencies.map((dep) => dep.name).sort() }));
}

async function run() {
  const logger = new QueryCounterLogger();
  const expectedAdj = { a: ['b'], b: ['a'] };

  const dataSource = new DataSource({
    type: 'sqlite',
    database: ':memory:',
    entities: [NodeSchema],
    synchronize: true,
    logging: ['query'],
    logger,
  });

  await dataSource.initialize();
  const repo = dataSource.getRepository<Node>('Node');

  const a = repo.create({ name: 'a', dependencies: [] });
  const b = repo.create({ name: 'b', dependencies: [] });
  a.dependencies = [b];
  b.dependencies = [a];
  await repo.save([a, b]);

  const roots = await repo.find({
    where: [{ name: 'a' }, { name: 'b' }],
    relations: { dependencies: { dependencies: true } },
    order: { name: 'ASC' },
  });

  const queriesAfterHydration = logger.queryCount;

  for (const root of roots) {
    for (const dep of root.dependencies) {
      void dep.dependencies.length;
    }
  }

  const queryGate =
    logger.queryCount === queriesAfterHydration
      ? { pass: true, reason: null }
      : { pass: false, reason: `expected no additional queries during traversal, saw +${logger.queryCount - queriesAfterHydration}` };
  const graphCheck = smartCheck(roots, expectedAdj, {
    getId: (node) => node.name,
    getDeps: (node) => node.dependencies,
  });
  const hydration = queryGate.pass && graphCheck.pass ? 'HYDRATION PASS' : 'HYDRATION FAIL';

  const serialization = finalizeSerialization(() => JSON.stringify(toCycleSafeProjection(roots)));

  console.log('typeorm-test-positive');
  console.log('hydration:', hydration);
  console.log('queryGate:', queryGate);
  console.log('smartCheck:', graphCheck);
  console.log('serialization:', serialization);

  await dataSource.destroy();
}

run().catch((error) => {
  console.error('typeorm-test-positive failed:', error);
  process.exitCode = 1;
});
