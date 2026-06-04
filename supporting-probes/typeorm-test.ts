import 'reflect-metadata';
import { DataSource, EntitySchema, Logger } from 'typeorm';
import { finalizeSerialization, smartCheck } from './ts/shared';
import { PROBE_IDENTITIES } from './ts/probe-config';
import { formatErrorDetail, getNodePackageVersion, writeProbeResult } from './ts/result-builder';

const verbose = process.env.PROBE_VERBOSE === '1';

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
      inverseSide: 'dependencies',
    },
  },
});

class QueryCounterLogger implements Logger {
  public queryCount = 0;

  logQuery(query: string): void {
    this.queryCount += 1;
    if (verbose) {
      console.log('[sql]', query);
    }
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

  const dataSource = new DataSource({
    type: 'sqlite',
    database: ':memory:',
    entities: [NodeSchema],
    synchronize: true,
    logging: true,
    logger,
  });

  try {
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

    const extraQueries = logger.queryCount - queriesAfterHydration;
    if (extraQueries === 0) {
      findings.queryGate = { result: 'PASS', detail: 'No additional queries observed during traversal.' };
    } else {
      findings.queryGate = {
        result: 'FAIL',
        extraQueries,
        detail: `Expected 0 additional queries during traversal, observed ${extraQueries}.`,
      };
    }

    const graphCheck = smartCheck(roots, expectedAdj, {
      getId: (node) => node.name,
      getDeps: (node) => node.dependencies,
    });

    if (graphCheck.pass) {
      findings.smartCheck = { result: 'PASS', detail: 'Identity and dependency closure checks passed.' };
    } else {
      findings.smartCheck = { result: 'FAIL', detail: graphCheck.reason ?? 'Identity/closure check failed.' };
    }

    findings.hydration =
      findings.queryGate.result === 'PASS' && findings.smartCheck.result === 'PASS'
        ? { result: 'PASS', detail: 'Hydration check passed.' }
        : {
            result: 'FAIL',
            detail: `Hydration failed: queryGate=${findings.queryGate.result}, smartCheck=${findings.smartCheck.result}.`,
          };

    const negativeSerialization = finalizeSerialization(() => JSON.stringify(roots));
    const positiveSerialization = finalizeSerialization(() => JSON.stringify(toCycleSafeProjection(roots)));

    if (negativeSerialization === 'SERIALIZE_PASS') {
      findings.serialize = {
        result: 'SERIALIZE_PASS',
        detail: 'Direct JSON serialization passed. Cycle-safe baseline serialization also passed.',
      };
    } else {
      findings.serialize = {
        result: negativeSerialization,
        detail: `Direct JSON serialization failed (${negativeSerialization}); cycle-safe baseline projection serialization result was ${positiveSerialization}.`,
      };
    }

    const outputPath = writeProbeResult({
      ...PROBE_IDENTITIES.typeorm,
      libraryVersion: getNodePackageVersion('typeorm'),
      runtimeVersion: process.version,
      findings,
    });

    console.log('typeorm-test');
    console.log('hydration:', findings.hydration.result === 'PASS' ? 'HYDRATION PASS' : 'HYDRATION FAIL');
    console.log('queryGate:', findings.queryGate);
    console.log('smartCheck:', findings.smartCheck);
    console.log('serialization:', findings.serialize.result);
    console.log('json:', outputPath);
  } catch (error) {
    findings.hydration = { result: 'FAIL', detail: formatErrorDetail(error) };
    findings.queryGate = { result: 'FAIL', detail: formatErrorDetail(error) };
    findings.smartCheck = { result: 'FAIL', detail: formatErrorDetail(error) };
    findings.serialize = { result: 'SERIALIZE_FAIL_OTHER', detail: formatErrorDetail(error) };

    writeProbeResult({
      ...PROBE_IDENTITIES.typeorm,
      libraryVersion: getNodePackageVersion('typeorm'),
      runtimeVersion: process.version,
      findings,
    });

    console.error('typeorm-test failed:', error);
    process.exitCode = 1;
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }
}

void run();
