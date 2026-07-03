import { PrismaClient } from '@prisma/client';
import { finalizeSerialization, smartCheck } from './ts/shared';
import { PROBE_IDENTITIES } from './ts/probe-config';
import { formatErrorDetail, getNodePackageVersion, writeProbeResult } from './ts/result-builder';
import { printProbeReport } from './ts/report';

const STRATEGY = "node.findMany({ where:{ name:'a' } }) <- relation via schema, no nested include";

type PrismaNode = {
  name: string;
  dependencies?: PrismaNode[];
};

const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });

async function run() {
  const expectedAdj = { a: ['b'], b: ['c'], c: [] };
  let queryCount = 0;
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

  prisma.$on('query', () => {
    queryCount += 1;
  });

  try {
    await prisma.node.deleteMany();

    await prisma.node.create({ data: { name: 'a' } });
    await prisma.node.create({ data: { name: 'b' } });
    await prisma.node.create({ data: { name: 'c' } });
    await prisma.node.update({ where: { name: 'a' }, data: { dependencies: { connect: { name: 'b' } } } });
    await prisma.node.update({ where: { name: 'b' }, data: { dependencies: { connect: { name: 'c' } } } });

    const roots = (await prisma.node.findMany({
      where: { name: { in: ['a'] } },
      orderBy: { name: 'asc' },
    })) as PrismaNode[];

    const queriesAfterHydration = queryCount;

    for (const root of roots) {
      const rootDeps = root.dependencies ?? [];
      for (const dep of rootDeps) {
        void (dep.dependencies ?? []).length;
      }
    }

    const extraQueries = queryCount - queriesAfterHydration;
    findings.queryGate =
      extraQueries === 0
        ? { result: 'PASS', detail: 'No additional queries observed during traversal.' }
        : { result: 'FAIL', extraQueries, detail: `Expected 0 additional queries during traversal, observed ${extraQueries}.` };

    const graphCheck = smartCheck(roots, expectedAdj, {
      getId: (node) => node.name,
      getDeps: (node) => node.dependencies ?? [],
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
      jsonPath: outputPath,
      metrics: {
        reached: graphCheck.uniqueIds,
        expected: Object.keys(expectedAdj).length,
        edges: graphCheck.edgesTraversed,
        extraQueries,
        identityStable: !graphCheck.reason?.includes('multiple in-memory instances'),
      },
    });
  } catch (error) {
    const detail = formatErrorDetail(error);
    findings.hydration = { result: 'FAIL', detail };
    findings.queryGate = { result: 'FAIL', detail };
    findings.smartCheck = { result: 'FAIL', detail };
    findings.serialize = { result: 'SERIALIZE_FAIL_OTHER', detail };

    const outputPath = writeProbeResult({
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
      jsonPath: outputPath,
    });
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void run();
