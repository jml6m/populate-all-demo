import { Collection, EntitySchema, MikroORM } from '@mikro-orm/core';
import { SqliteDriver } from '@mikro-orm/sqlite';
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
const STRATEGY = "em.find(Node, { id:'a' }, { populate: ['*'] }) <- schema/default wildcard populate";
const expectedAdj: Record<string, string[]> = { a: ['b'], b: ['c'], c: [] };

class Node {
  id!: string;
  dependencies = new Collection<Node>(this);
  dependents = new Collection<Node>(this);
}

type SerializableNode = {
  id: string;
  dependencies: SerializableNode[];
};

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

function getDeps(node: Node): Node[] {
  return node.dependencies.getItems();
}

function toPlainCycleGraph(roots: Node[]): SerializableNode[] {
  const byRef = new Map<Node, SerializableNode>();

  const materialize = (node: Node): SerializableNode => {
    const existing = byRef.get(node);
    if (existing !== undefined) {
      return existing;
    }

    const plain: SerializableNode = { id: node.id, dependencies: [] };
    byRef.set(node, plain);
    plain.dependencies = node.dependencies.getItems().map((dep) => materialize(dep));
    return plain;
  };

  return roots.map((node) => materialize(node));
}

/** Seed a -> b -> c. Infrastructure only; the fetch below is the operation under research. */
async function seed(orm: MikroORM<SqliteDriver>): Promise<void> {
  await orm.schema.refreshDatabase();

  const a = new Node();
  a.id = 'a';
  const b = new Node();
  b.id = 'b';
  const c = new Node();
  c.id = 'c';

  a.dependencies.add(b);
  b.dependencies.add(c);

  await orm.em.persistAndFlush([a, b, c]);
  orm.em.clear();
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
    getId: (node) => node.id,
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
  const serialization = finalizeSerialization(() => JSON.stringify(toPlainCycleGraph(roots)));
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

  const findings = pendingFindings();
  let metrics: ProbeMetrics | undefined;
  let verdictReason: string | undefined;
  let orm: MikroORM<SqliteDriver> | undefined;

  try {
    // ---- Setup (infrastructure — a failure here is an environment problem, not a research result) ----
    let setupOk = true;
    try {
      orm = await MikroORM.init<SqliteDriver>({
        driver: SqliteDriver,
        entities: [NodeSchema],
        dbName: ':memory:',
        allowGlobalContext: true,
        debug: verbose,
        logger: (message) => {
          if (message.toLowerCase().includes('select') || message.toLowerCase().includes('insert') || message.toLowerCase().includes('update')) {
            queryCount += 1;
          }
          if (verbose) {
            console.log(message);
          }
        },
      });
      await seed(orm);
    } catch (setupError) {
      setupOk = false;
      const detail = formatErrorDetail(setupError);
      findings.hydration = { result: 'FAIL', detail: `probe setup failed: ${detail}` };
      markGatesNotRun(findings, 'not reached -- probe setup failed before the fetch stage');
      verdictReason = `probe setup failed -- ${detail}`;
      process.exitCode = 1;
    }

    // ---- Stage 1: the operation under research — schema-driven fetch of root `a` ----
    if (setupOk && orm !== undefined) {
      let roots: Node[] | undefined;
      try {
        roots = await orm.em.find(Node, { id: { $in: ['a'] } }, { populate: ['*'], orderBy: { id: 'asc' } });
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
    if (orm !== undefined) {
      await orm.close(true);
    }
  }

  const jsonPath = writeProbeResult({
    ...PROBE_IDENTITIES.mikroorm,
    libraryVersion: getNodePackageVersion('@mikro-orm/core'),
    runtimeVersion: process.version,
    findings,
  });

  printProbeReport({
    probe: PROBE_IDENTITIES.mikroorm.probe,
    library: PROBE_IDENTITIES.mikroorm.library,
    libraryVersion: getNodePackageVersion('@mikro-orm/core'),
    strategy: STRATEGY,
    findings,
    jsonPath,
    metrics,
    verdictReason,
  });
}

void run();
