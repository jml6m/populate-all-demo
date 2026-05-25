import mongoose, { Schema, model } from 'mongoose';
import { assertNoExtraQueries, finalizeSerialization, smartCheck } from './js/shared';

type NodeDoc = {
  name: string;
  dependencies: NodeDoc[];
};

const NodeSchema = new Schema({
  name: { type: String, required: true, unique: true },
  dependencies: [{ type: Schema.Types.ObjectId, ref: 'Node' }],
});

const NodeModel = model('Node', NodeSchema);

async function run() {
  const uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/supporting_probe_mongoose';
  const expectedAdj = { a: ['b'], b: ['a'] };
  let queryCount = 0;

  mongoose.set('debug', () => {
    queryCount += 1;
  });

  await mongoose.connect(uri);
  await NodeModel.deleteMany({});

  const a = await NodeModel.create({ name: 'a', dependencies: [] });
  const b = await NodeModel.create({ name: 'b', dependencies: [] });
  a.dependencies = [b._id];
  b.dependencies = [a._id];
  await a.save();
  await b.save();

  const roots = (await NodeModel.find({ name: { $in: ['a', 'b'] } })
    .populate({ path: 'dependencies', populate: { path: 'dependencies' } })
    .sort({ name: 1 })
    .exec()) as unknown as NodeDoc[];

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

  console.log('mongoose-test');
  console.log('hydration:', hydration);
  console.log('queryGate:', queryGate);
  console.log('smartCheck:', graphCheck);
  console.log('serialization:', serialization);

  await mongoose.disconnect();
}

run().catch((error) => {
  console.error('mongoose-test failed:', error);
  process.exitCode = 1;
});
