import mongoose, { Schema, model } from 'mongoose';
import { finalizeSerialization, smartCheck } from './ts/shared';
import { PROBE_IDENTITIES } from './ts/probe-config';
import { formatErrorDetail, getNodePackageVersion, writeProbeResult } from './ts/result-builder';
import { printProbeReport } from './ts/report';

const STRATEGY = "NodeModel.find({ name:'a' }) <- ObjectId refs, no .populate() (schema default)";

type NodeDoc = {
  name: string;
  dependencies: Array<NodeDoc | mongoose.Types.ObjectId>;
};

function isHydratedNode(value: NodeDoc | mongoose.Types.ObjectId): value is NodeDoc {
  return typeof value === 'object' && value !== null && 'name' in value && 'dependencies' in value;
}

const NodeSchema = new Schema({
  name: { type: String, required: true, unique: true },
  dependencies: [{ type: Schema.Types.ObjectId, ref: 'Node' }],
});

const NodeModel = model('Node', NodeSchema);

async function run() {
  const uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/supporting_probe_mongoose';
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

  mongoose.set('debug', () => {
    queryCount += 1;
  });

  try {
    await mongoose.connect(uri);
    await NodeModel.deleteMany({});

    const a = await NodeModel.create({ name: 'a', dependencies: [] });
    const b = await NodeModel.create({ name: 'b', dependencies: [] });
    const c = await NodeModel.create({ name: 'c', dependencies: [] });
    a.dependencies = [b._id];
    b.dependencies = [c._id];
    await a.save();
    await b.save();

    const roots = (await NodeModel.find({ name: { $in: ['a'] } })
      .sort({ name: 1 })
      .exec()) as unknown as NodeDoc[];

    const queriesAfterHydration = queryCount;

    for (const root of roots) {
      const rootDeps = root.dependencies.filter((dep) => isHydratedNode(dep));
      for (const dep of rootDeps) {
        void dep.dependencies.filter((next) => isHydratedNode(next)).length;
      }
    }

    const extraQueries = queryCount - queriesAfterHydration;
    findings.queryGate =
      extraQueries === 0
        ? { result: 'PASS', detail: 'No additional queries observed during traversal.' }
        : { result: 'FAIL', extraQueries, detail: `Expected 0 additional queries during traversal, observed ${extraQueries}.` };

    const graphCheck = smartCheck(roots, expectedAdj, {
      getId: (node) => node.name,
      getDeps: (node) => node.dependencies.filter((dep) => isHydratedNode(dep)),
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

    printProbeReport({
      probe: PROBE_IDENTITIES.mongoose.probe,
      library: PROBE_IDENTITIES.mongoose.library,
      libraryVersion: getNodePackageVersion('mongoose'),
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
      ...PROBE_IDENTITIES.mongoose,
      libraryVersion: getNodePackageVersion('mongoose'),
      runtimeVersion: process.version,
      findings,
    });

    printProbeReport({
      probe: PROBE_IDENTITIES.mongoose.probe,
      library: PROBE_IDENTITIES.mongoose.library,
      libraryVersion: getNodePackageVersion('mongoose'),
      strategy: STRATEGY,
      findings,
      jsonPath: outputPath,
    });
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

void run();
