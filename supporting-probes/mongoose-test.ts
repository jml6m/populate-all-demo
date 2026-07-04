import mongoose, { Schema, model } from 'mongoose';
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

const STRATEGY = "NodeModel.find({ name:'a' }) <- ObjectId refs, no .populate() (schema default)";
const expectedAdj: Record<string, string[]> = { a: ['b'], b: ['c'], c: [] };

type NodeDoc = {
  name: string;
  dependencies: Array<NodeDoc | mongoose.Types.ObjectId>;
};

function isHydratedNode(value: NodeDoc | mongoose.Types.ObjectId): value is NodeDoc {
  return typeof value === 'object' && value !== null && 'name' in value && 'dependencies' in value;
}

function getDeps(node: NodeDoc): NodeDoc[] {
  return node.dependencies.filter((dep): dep is NodeDoc => isHydratedNode(dep));
}

const NodeSchema = new Schema({
  name: { type: String, required: true, unique: true },
  dependencies: [{ type: Schema.Types.ObjectId, ref: 'Node' }],
});

const NodeModel = model('Node', NodeSchema);

/** Connect + seed a -> b -> c. Infrastructure only; a bad connection fails here, not in the fetch. */
async function seed(uri: string): Promise<void> {
  await mongoose.connect(uri);
  await NodeModel.deleteMany({});

  const a = await NodeModel.create({ name: 'a', dependencies: [] });
  const b = await NodeModel.create({ name: 'b', dependencies: [] });
  const c = await NodeModel.create({ name: 'c', dependencies: [] });
  a.dependencies = [b._id];
  b.dependencies = [c._id];
  await a.save();
  await b.save();
}

function evaluateGraph(roots: NodeDoc[], findings: ProbeFindings, getQueryCount: () => number): ProbeMetrics {
  // queryGate: traversal must not trigger further queries if hydration was complete.
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
  const uri = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017/supporting_probe_mongoose';
  let queryCount = 0;
  mongoose.set('debug', () => {
    queryCount += 1;
  });

  const findings = pendingFindings();
  let metrics: ProbeMetrics | undefined;
  let verdictReason: string | undefined;

  try {
    // ---- Setup (infrastructure — an unreachable MongoDB fails here, not in the fetch) ----
    let setupOk = true;
    try {
      await seed(uri);
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
      let roots: NodeDoc[] | undefined;
      try {
        roots = (await NodeModel.find({ name: { $in: ['a'] } })
          .sort({ name: 1 })
          .exec()) as unknown as NodeDoc[];
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
    await mongoose.disconnect();
  }

  const jsonPath = writeProbeResult({
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
    jsonPath,
    metrics,
    verdictReason,
  });
}

void run();
