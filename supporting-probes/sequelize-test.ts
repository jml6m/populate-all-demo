import { DataTypes, Model, Sequelize } from 'sequelize';
import { finalizeSerialization, smartCheck } from './ts/shared';
import { PROBE_IDENTITIES } from './ts/probe-config';
import { formatErrorDetail, getNodePackageVersion, writeProbeResult } from './ts/result-builder';

const verbose = process.env.PROBE_VERBOSE === '1';

class Node extends Model {
  declare id: number;
  declare name: string;
  declare dependencies: Node[];
}

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

  const sequelize = new Sequelize('sqlite::memory:', {
    logging: (sql) => {
      queryCount += 1;
      if (verbose) {
        console.log('[sql]', sql);
      }
    },
  });

  try {
    Node.init(
      {
        id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
        name: { type: DataTypes.STRING, allowNull: false, unique: true },
      },
      { sequelize, modelName: 'Node', tableName: 'nodes' }
    );

    Node.belongsToMany(Node, { through: 'node_dependencies', as: 'dependencies', foreignKey: 'nodeId', otherKey: 'dependencyId' });

    await sequelize.sync({ force: true });

    const a = await Node.create({ name: 'a' });
    const b = await Node.create({ name: 'b' });
    await (a as Node & { setDependencies(dependencies: Node[]): Promise<void> }).setDependencies([b]);
    await (b as Node & { setDependencies(dependencies: Node[]): Promise<void> }).setDependencies([a]);

    const roots = await Node.findAll({
      where: { name: ['a', 'b'] },
      include: [{ association: 'dependencies', include: [{ association: 'dependencies' }] }],
      order: [['name', 'ASC']],
    });

    const queriesAfterHydration = queryCount;

    for (const root of roots) {
      for (const dep of (root as Node).dependencies) {
        void dep.dependencies.length;
      }
    }

    const extraQueries = queryCount - queriesAfterHydration;
    findings.queryGate =
      extraQueries === 0
        ? { result: 'PASS', detail: 'No additional queries observed during traversal.' }
        : { result: 'FAIL', extraQueries, detail: `Expected 0 additional queries during traversal, observed ${extraQueries}.` };

    const graphCheck = smartCheck(roots as Node[], expectedAdj, {
      getId: (node) => node.name,
      getDeps: (node) => node.dependencies,
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
      ...PROBE_IDENTITIES.sequelize,
      libraryVersion: getNodePackageVersion('sequelize'),
      runtimeVersion: process.version,
      findings,
    });

    console.log('sequelize-test');
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
      ...PROBE_IDENTITIES.sequelize,
      libraryVersion: getNodePackageVersion('sequelize'),
      runtimeVersion: process.version,
      findings,
    });

    console.error('sequelize-test failed:', error);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

void run();
