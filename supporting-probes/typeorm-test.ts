import 'reflect-metadata';
import { DataSource, EntitySchema, Logger } from 'typeorm';
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
const STRATEGY = "repo.find({ where:{ name:'a' } }) <- schema relation eager:true (self-referential m:n)";
const expectedAdj: Record<string, string[]> = { a: ['b'], b: ['c'], c: [] };

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
      eager: true,
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

/** Seed a -> b -> c. Infrastructure only; the fetch below is the operation under research. */
async function seed(dataSource: DataSource): Promise<void> {
  const repo = dataSource.getRepository<Node>('Node');
  const a = repo.create({ name: 'a', dependencies: [] });
  const b = repo.create({ name: 'b', dependencies: [] });
  const c = repo.create({ name: 'c', dependencies: [] });
  a.dependencies = [b];
  b.dependencies = [c];
  await repo.save([a, b, c]);
}

/**
 * Runs the three downstream gates against a graph the fetch actually returned,
 * mutating `findings` in place and returning the observed metrics. Operates only
 * on already-materialized data and pure checks, so it does not swallow errors —
 * a genuine bug here should surface, not be mislabeled as a probe failure.
 */
function evaluateGraph(roots: Node[], findings: ProbeFindings, getQueryCount: () => number): ProbeMetrics {
  // queryGate: traversal must not trigger further SQL if hydration was complete.
  const queriesAfterHydration = getQueryCount();
  for (const root of roots) {
    for (const dep of root.dependencies) {
      void dep.dependencies.length;
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
    getDeps: (node) => node.dependencies,
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
  const negativeSerialization = finalizeSerialization(() => JSON.stringify(roots));
  const positiveSerialization = finalizeSerialization(() => JSON.stringify(toCycleSafeProjection(roots)));
  findings.serialize =
    negativeSerialization === 'SERIALIZE_PASS'
      ? { result: 'SERIALIZE_PASS', detail: 'Direct JSON serialization passed. Cycle-safe baseline serialization also passed.' }
      : {
          result: negativeSerialization,
          detail: `Direct JSON serialization failed (${negativeSerialization}); cycle-safe baseline projection serialization result was ${positiveSerialization}.`,
        };

  return {
    reached: graphCheck.uniqueIds,
    expected: Object.keys(expectedAdj).length,
    edges: graphCheck.edgesTraversed,
    extraQueries,
    identityStable: !graphCheck.reason?.includes('multiple in-memory instances'),
  };
}

async function run() {
  const logger = new QueryCounterLogger();
  const dataSource = new DataSource({
    type: 'sqlite',
    database: ':memory:',
    entities: [NodeSchema],
    synchronize: true,
    logging: true,
    logger,
  });

  const findings = pendingFindings();
  let metrics: ProbeMetrics | undefined;
  let verdictReason: string | undefined;

  try {
    // ---- Setup (infrastructure — a failure here is an environment problem, not a research result) ----
    let setupOk = true;
    try {
      await dataSource.initialize();
      await seed(dataSource);
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
      const repo = dataSource.getRepository<Node>('Node');
      let roots: Node[] | undefined;
      try {
        roots = await repo.find({ where: [{ name: 'a' }], order: { name: 'ASC' } });
        findings.fetch = { result: 'OK', detail: `Schema-driven fetch returned ${roots.length} root row(s).` };
      } catch (fetchError) {
        // Not a runtime data fault: TypeORM cannot BUILD an eager query for a self-referential
        // relation (it expands the self-join without bound). Verified to overflow on an empty
        // table too, so it is independent of the row count. The raw error is kept on line 2.
        const detail = formatErrorDetail(fetchError);
        findings.fetch = {
          result: 'ERROR',
          detail: `query not constructible -- eager self-relation join recurses without bound (data-independent)\n${detail}`,
        };
        findings.hydration = { result: 'FAIL', detail: 'fetch did not return a graph' };
        markGatesNotRun(findings, 'not reached -- the schema-driven eager query could not be constructed');
        verdictReason = 'schema-level eager self-relation query not constructible (data-independent)';
        process.exitCode = 1;
      }

      // ---- Stages 2-4: gates run only against a graph the fetch actually returned ----
      if (roots !== undefined) {
        metrics = evaluateGraph(roots, findings, () => logger.queryCount);
      }
    }
  } finally {
    if (dataSource.isInitialized) {
      await dataSource.destroy();
    }
  }

  const jsonPath = writeProbeResult({
    ...PROBE_IDENTITIES.typeorm,
    libraryVersion: getNodePackageVersion('typeorm'),
    runtimeVersion: process.version,
    findings,
  });

  printProbeReport({
    probe: PROBE_IDENTITIES.typeorm.probe,
    library: PROBE_IDENTITIES.typeorm.library,
    libraryVersion: getNodePackageVersion('typeorm'),
    strategy: STRATEGY,
    findings,
    jsonPath,
    metrics,
    verdictReason,
  });
}

void run();
