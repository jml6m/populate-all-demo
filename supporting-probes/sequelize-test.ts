import { DataTypes, Model, Sequelize } from 'sequelize';
import { finalizeSerialization, smartCheck } from './ts/shared';
import { PROBE_IDENTITIES } from './ts/probe-config';
import {
  formatErrorDetail,
  getNodePackageVersion,
  markGatesNotRun,
  pendingFindings,
  writeProbeResult,
  type ProbeFindings,
} from './ts/result-builder';
import { printProbeReport, type ProbeMetrics } from './ts/report';

const verbose = process.env.PROBE_VERBOSE === '1';
const STRATEGY = "Node.findAll({ where:{ name:'a' } }) <- belongsToMany, no query-time include (schema default)";
const expectedAdj: Record<string, string[]> = { a: ['b'], b: ['c'], c: [] };

class Node extends Model {
  declare id: number;
  declare name: string;
  declare dependencies: Node[];
}

function getDeps(node: Node): Node[] {
  return Array.isArray(node.dependencies) ? node.dependencies : [];
}

/** Define the model + schema and seed a -> b -> c. Infrastructure only. */
async function seed(sequelize: Sequelize): Promise<void> {
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
  const c = await Node.create({ name: 'c' });
  await (a as Node & { setDependencies(dependencies: Node[]): Promise<void> }).setDependencies([b]);
  await (b as Node & { setDependencies(dependencies: Node[]): Promise<void> }).setDependencies([c]);
}

function evaluateGraph(roots: Node[], findings: ProbeFindings, getQueryCount: () => number): ProbeMetrics {
  // queryGate: traversal must not trigger further SQL if hydration was complete.
  const queriesAfterHydration = getQueryCount();
  for (const root of roots) {
    for (const dep of getDeps(root)) {
      void getDeps(dep).length;
    }
  }
  const extraQueries = getQueryCount() - queriesAfterHydration;
  findings.queryGate =
    extraQueries === 0
      ? { result: 'PASS', detail: 'No additional queries observed during traversal.' }
      : { result: 'FAIL', extraQueries, detail: `Expected 0 additional queries during traversal, observed ${extraQueries}.` };

  // smartCheck: identity + dependency-closure of the reachable graph.
  const graphCheck = smartCheck(roots, expectedAdj, {
    getId: (node) => node.name,
    getDeps,
  });
  findings.smartCheck = graphCheck.pass
    ? { result: 'PASS', detail: 'Identity and dependency closure checks passed.' }
    : { result: 'FAIL', detail: graphCheck.reason ?? 'Identity/closure check failed.' };

  // hydration rollup: full hydration = complete closure with no extra queries.
  findings.hydration =
    findings.queryGate.result === 'PASS' && findings.smartCheck.result === 'PASS'
      ? { result: 'PASS', detail: 'Full hydration achieved from the root fetch (complete acyclic closure, no extra queries).' }
      : { result: 'FAIL', detail: `Full hydration not achieved: queryGate=${findings.queryGate.result}, smartCheck=${findings.smartCheck.result}.` };

  // serialize: independent of smartCheck; needs only a materialized graph.
  const serialization = finalizeSerialization(() => JSON.stringify(roots));
  findings.serialize =
    serialization === 'SERIALIZE_PASS'
      ? { result: serialization, detail: 'JSON serialization passed.' }
      : { result: serialization, detail: `JSON serialization failed with ${serialization}.` };

  return {
    reached: graphCheck.uniqueIds,
    expected: Object.keys(expectedAdj).length,
    edges: graphCheck.edgesTraversed,
    extraQueries,
    identityStable: !graphCheck.reason?.includes('multiple in-memory instances'),
  };
}

async function run() {
  let queryCount = 0;
  const sequelize = new Sequelize('sqlite::memory:', {
    logging: (sql) => {
      queryCount += 1;
      if (verbose) {
        console.log('[sql]', sql);
      }
    },
  });

  const findings = pendingFindings();
  let metrics: ProbeMetrics | undefined;
  let verdictReason: string | undefined;

  try {
    // ---- Setup (infrastructure — a failure here is an environment problem, not a research result) ----
    let setupOk = true;
    try {
      await seed(sequelize);
    } catch (setupError) {
      setupOk = false;
      const detail = formatErrorDetail(setupError);
      findings.hydration = { result: 'FAIL', detail: `probe setup failed: ${detail}` };
      markGatesNotRun(findings, 'not reached -- probe setup failed before the fetch stage');
      verdictReason = `probe setup failed -- ${detail}`;
      process.exitCode = 1;
    }

    // ---- Stage 1: the operation under research — schema-driven fetch of root `a` ----
    if (setupOk) {
      let roots: Node[] | undefined;
      try {
        roots = await Node.findAll({ where: { name: ['a'] }, order: [['name', 'ASC']] });
        findings.fetch = { result: 'OK', detail: `Schema-driven fetch returned ${roots.length} root row(s).` };
      } catch (fetchError) {
        const detail = formatErrorDetail(fetchError);
        findings.fetch = { result: 'ERROR', detail };
        findings.hydration = { result: 'FAIL', detail: 'fetch did not return a graph' };
        markGatesNotRun(findings, 'not reached -- the schema-driven fetch threw before returning a graph');
        verdictReason = `schema-driven fetch threw -- ${detail}`;
        process.exitCode = 1;
      }

      // ---- Stages 2-4: gates run only against a graph the fetch actually returned ----
      if (roots !== undefined) {
        metrics = evaluateGraph(roots, findings, () => queryCount);
      }
    }
  } finally {
    await sequelize.close();
  }

  const jsonPath = writeProbeResult({
    ...PROBE_IDENTITIES.sequelize,
    libraryVersion: getNodePackageVersion('sequelize'),
    runtimeVersion: process.version,
    findings,
  });

  printProbeReport({
    probe: PROBE_IDENTITIES.sequelize.probe,
    library: PROBE_IDENTITIES.sequelize.library,
    libraryVersion: getNodePackageVersion('sequelize'),
    strategy: STRATEGY,
    findings,
    jsonPath,
    metrics,
    verdictReason,
  });
}

void run();
