import { DataTypes, Model, Sequelize } from 'sequelize';
import { assertNoExtraQueries, finalizeSerialization, smartCheck } from './js/shared';

class Node extends Model {
  declare id: number;
  declare name: string;
  declare dependencies: Node[];
}

async function run() {
  let queryCount = 0;
  const expectedAdj = { a: ['b'], b: ['a'] };

  const sequelize = new Sequelize('sqlite::memory:', {
    logging: (sql) => {
      queryCount += 1;
      console.log('[sql]', sql);
    },
  });

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
  await a.$set('dependencies', [b]);
  await b.$set('dependencies', [a]);

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

  const queryGate = assertNoExtraQueries(queriesAfterHydration, queryCount);
  const graphCheck = smartCheck(roots as Node[], expectedAdj, {
    getId: (node) => node.name,
    getDeps: (node) => node.dependencies,
  });
  const hydration = queryGate.pass && graphCheck.pass ? 'HYDRATION PASS' : 'HYDRATION FAIL';

  const serialization = finalizeSerialization(() => JSON.stringify(roots));

  console.log('sequelize-test');
  console.log('hydration:', hydration);
  console.log('queryGate:', queryGate);
  console.log('smartCheck:', graphCheck);
  console.log('serialization:', serialization);

  await sequelize.close();
}

run().catch((error) => {
  console.error('sequelize-test failed:', error);
  process.exitCode = 1;
});
