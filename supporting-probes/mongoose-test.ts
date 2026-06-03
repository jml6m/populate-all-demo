import mongoose, { Schema, model } from 'mongoose';
import { finalizeSerialization, smartCheck } from './ts/shared';
import { PROBE_IDENTITIES } from './ts/probe-config';
import { formatErrorDetail, getNodePackageVersion, writeProbeResult } from './ts/result-builder';

type NodeDoc = {
  name: string;
  dependencies: Array<NodeDoc | mongoose.Types.ObjectId>;
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

  mongoose.set('debug', () => {
    queryCount += 1;
  });

  try {
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
      for (const dep of root.dependencies as NodeDoc[]) {
        void (dep.dependencies as NodeDoc[]).length;
      }
    }

    const extraQueries = queryCount - queriesAfterHydration;
    findings.queryGate =
      extraQueries === 0
        ? { result: 'PASS', detail: 'No additional queries observed during traversal.' }
        : { result: 'FAIL', extraQueries, detail: `Expected 0 additional queries during traversal, observed ${extraQueries}.` };

    const graphCheck = smartCheck(roots, expectedAdj, {
      getId: (node) => node.name,
      getDeps: (node) => node.dependencies as NodeDoc[],
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
      ...PROBE_IDENTITIES.mongoose,
      libraryVersion: getNodePackageVersion('mongoose'),
      runtimeVersion: process.version,
      findings,
    });

    console.log('mongoose-test');
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
      ...PROBE_IDENTITIES.mongoose,
      libraryVersion: getNodePackageVersion('mongoose'),
      runtimeVersion: process.version,
      findings,
    });

    console.error('mongoose-test failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

void run();
