import { PrismaClient } from '@prisma/client';
import { assertNoExtraQueries, finalizeSerialization, smartCheck } from './js/shared';

type PrismaNode = {
  name: string;
  dependencies: PrismaNode[];
};

const prisma = new PrismaClient();

async function run() {
  const expectedAdj = { a: ['b'], b: ['a'] };
  let queryCount = 0;

  prisma.$on('query', () => {
    queryCount += 1;
  });

  await prisma.node.deleteMany();

  await prisma.node.create({ data: { name: 'a' } });
  await prisma.node.create({ data: { name: 'b' } });
  await prisma.node.update({ where: { name: 'a' }, data: { dependencies: { connect: { name: 'b' } } } });
  await prisma.node.update({ where: { name: 'b' }, data: { dependencies: { connect: { name: 'a' } } } });

  const roots = (await prisma.node.findMany({
    where: { name: { in: ['a', 'b'] } },
    include: { dependencies: { include: { dependencies: true } } },
    orderBy: { name: 'asc' },
  })) as PrismaNode[];

  const queriesAfterHydration = queryCount;

  for (const root of roots) {
    for (const dep of root.dependencies) {
      void dep.dependencies.length;
    }
  }

  const queryGate = assertNoExtraQueries(queriesAfterHydration, queryCount);
  const graphCheck = smartCheck(roots, expectedAdj, {
    getId: (node) => node.name,
    getDeps: (node) => node.dependencies,
  });
  const hydration = queryGate.pass && graphCheck.pass ? 'HYDRATION PASS' : 'HYDRATION FAIL';

  const serialization = finalizeSerialization(() => JSON.stringify(roots));

  console.log('prisma-test');
  console.log('hydration:', hydration);
  console.log('queryGate:', queryGate);
  console.log('smartCheck:', graphCheck);
  console.log('serialization:', serialization);

  await prisma.$disconnect();
}

run().catch(async (error) => {
  console.error('prisma-test failed:', error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
