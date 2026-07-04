import { PrismaClient } from '@prisma/client';
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

const STRATEGY = "node.findMany({ where:{ name:'a' } }) <- relation via schema, no nested include";
const expectedAdj: Record<string, string[]> = { a: ['b'], b: ['c'], c: [] };

type PrismaNode = {
  name: string;
  dependencies?: PrismaNode[];
};

const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });

function getDeps(node: PrismaNode): PrismaNode[] {
  return node.dependencies ?? [];
}

/** Seed a -> b -> c. Infrastructure only; the fetch below is the operation under research. */
async function seed(): Promise<void> {
  await prisma.node.deleteMany();
  await prisma.node.create({ data: { name: 'a' } });
  await prisma.node.create({ data: { name: 'b' } });
  await prisma.node.create({ data: { name: 'c' } });
  await prisma.node.update({ where: { name: 'a' }, data: { dependencies: { connect: { name: 'b' } } } });
  await prisma.node.update({ where: { name: 'b' }, data: { dependencies: { connect: { name: 'c' } } } });
}

function evaluateGraph(roots: PrismaNode[], findings: ProbeFindings, getQueryCount: () => number): ProbeMetrics {
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
  prisma.$on('query', () => {
    queryCount += 1;
  });

  const findings = pendingFindings();
  let metrics: ProbeMetrics | undefined;
  let verdictReason: string | undefined;

  try {
    // ---- Setup (infrastructure — a failure here is an environment problem, not a research result) ----
    let setupOk = true;
    try {
      await seed();
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
      let roots: PrismaNode[] | undefined;
      try {
        roots = (await prisma.node.findMany({ where: { name: { in: ['a'] } }, orderBy: { name: 'asc' } })) as PrismaNode[];
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
    await prisma.$disconnect();
  }

  const jsonPath = writeProbeResult({
    ...PROBE_IDENTITIES.prisma,
    libraryVersion: getNodePackageVersion('@prisma/client'),
    runtimeVersion: process.version,
    findings,
  });

  printProbeReport({
    probe: PROBE_IDENTITIES.prisma.probe,
    library: PROBE_IDENTITIES.prisma.library,
    libraryVersion: getNodePackageVersion('@prisma/client'),
    strategy: STRATEGY,
    findings,
    jsonPath,
    metrics,
    verdictReason,
  });
}

void run();
