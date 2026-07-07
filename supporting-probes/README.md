# Supporting probes

Supporting probes validate hydration and consumer behavior across ORM ecosystems.

## Hydration scenarios under test

- Schema-driven full hydration of **cyclic** objects (documentation-driven in this patch cycle): `A -> B -> A`
- Schema-driven full hydration of **acyclic** objects (implemented in probe code): `A -> B -> C`

## Commands

- `npm run probe:ts` — runs only TypeScript probes (`typeorm`, `sequelize`, `mikroorm`, `prisma`, `mongoose`).
- `npm run probe:all` — runs all probes (TypeScript + SQLAlchemy + ActiveRecord + Hibernate + EF Core). This is the canonical CI/release command.

The orchestrator summary table shows one `outcome` column (`ACYCLIC_PASS` / `ACYCLIC_FAIL`) next to per-stage columns (`fetch`, `queryGate`, `smartCheck`, `serialize`). `ACYCLIC_PASS` requires `fetch=OK` and every gate to pass. The stage columns are independent measurements, so a passing gate can sit next to the failure that decides the row — e.g. `smartCheck=PASS` with `queryGate=FAIL` is the N+1 signature (correct topology, but assembled via per-edge lazy queries, so not schema-driven eager hydration).

## Prerequisites

- `probe:ts`: Node.js
- `probe:all`: Node.js, Python 3, Ruby, Java 21, .NET 8

The orchestrator fails fast before any probe starts if required runtimes are missing. Build tools (`mvn`, `javac`, `gem`) are not checked as central prerequisites — if a specific probe's build tool is missing, that probe will fail-soft with a fallback JSON. For reference: the Hibernate probe uses `mvn` and `javac` internally.

### Local setup for the Mongoose probe

The `mongoose` TypeScript probe is the only TypeScript probe that connects to MongoDB; to get a passing result, it needs a reachable MongoDB instance. The other TypeScript probes use SQLite (file or in-memory) and do not require external services.

```bash
docker run -d --name probe-mongo -p 27017:27017 mongo:7
cd supporting-probes
npm ci
npm run probe:ts
```

By default, the Mongoose probe uses `mongodb://127.0.0.1:27017/supporting_probe_mongoose` via `MONGODB_URI`. To point at a different host or database:

```bash
MONGODB_URI=mongodb://your-host:27017/your-db npm run probe:ts
```

If MongoDB is unreachable, `mongoose-test.ts` records a probe-level failure and exits non-zero, but the orchestrator continues running sibling probes and still prints the full summary table.

## Verbose SQL/query logs

Set `PROBE_VERBOSE=1` to enable per-probe SQL/query logging. The default is silent.

The `supporting-probes` workflow runs with `PROBE_VERBOSE=1` so workflow logs preserve full SQL traces for debugging.

## Output layout

Each orchestrator run computes one `PROBE_RUN_ID` (`YYYYMMDD-HHMMSS-<shortsha>`) and every probe writes JSON to:

- Local/unofficial runs: `supporting-probes/results/local/<run-id>/<probe>.json`
- Official release artifacts (future release workflow only): `supporting-probes/results/reference/v<N>/`

Non-release workflows must not write to `reference/`.

## JSON schema

Each probe writes one JSON document with alphabetically sorted keys and 2-space indentation. Findings follow the staged pipeline: `fetch` records the schema-driven query under test, then `hydration` (the rollup) and the `queryGate` / `smartCheck` / `serialize` gates. A stage that never runs because a prerequisite failed is recorded honestly as `NOT_RUN` / `SERIALIZE_NOT_RUN` rather than inheriting an unrelated error — as in the TypeORM example below:

```json
{
  "findings": {
    "fetch": {
      "detail": "query not constructible -- eager self-relation join recurses without bound (data-independent)\nRangeError: Maximum call stack size exceeded",
      "result": "ERROR"
    },
    "hydration": {
      "detail": "fetch did not return a graph",
      "result": "FAIL"
    },
    "queryGate": {
      "detail": "not reached -- the schema-driven eager query could not be constructed",
      "result": "NOT_RUN"
    },
    "serialize": {
      "detail": "not reached -- the schema-driven eager query could not be constructed",
      "result": "SERIALIZE_NOT_RUN"
    },
    "smartCheck": {
      "detail": "not reached -- the schema-driven eager query could not be constructed",
      "result": "NOT_RUN"
    }
  },
  "language": "typescript",
  "library": "TypeORM",
  "libraryVersion": "0.3.30",
  "outcome": "HYDRATION_FAIL",
  "probe": "typeorm",
  "runtimeVersion": "v22.17.1"
}
```

### Finding states

- `fetch`: `OK` \| `ERROR` \| `NOT_RUN` — the schema-driven query under research (the operation itself).
- `hydration`: `PASS` \| `FAIL` — rollup; `PASS` only when `queryGate` and `smartCheck` both pass.
- `queryGate`: `PASS` \| `FAIL` \| `NOT_RUN` — whether fetch query fired extra (N+1) queries.
- `smartCheck`: `PASS` \| `FAIL` \| `NOT_RUN` — in-memory identity + dependency-closure correctness.
- `serialize`: `SERIALIZE_PASS` \| `SERIALIZE_FAIL_CYCLE` \| `SERIALIZE_FAIL_OTHER` \| `SERIALIZE_NOT_RUN`.

`NOT_RUN` / `SERIALIZE_NOT_RUN` mean the stage was never executed because an earlier stage failed (e.g. the fetch threw), so the value is not a judgment — just an accurate "not reached".

### Outcome rollup

- `PASS`: all findings pass
- `HYDRATION_FAIL`: `findings.hydration.result === "FAIL"`
- `SERIALIZE_FAIL`: hydration passed and serialize is `SERIALIZE_FAIL_*`
- `MIXED`: any other combination
- `PROBE_LAUNCH_FAIL`: orchestrator fallback row when a probe does not write JSON output (typically after a non-zero exit)

Canonical implementation for rollup and TS JSON writing: `supporting-probes/ts/result-builder.ts`.

`PROBE_LAUNCH_FAIL` is emitted only by the orchestrator fallback path in `run-probes.ts`, never by a probe's self-reported JSON. This is the explicit "probe did not launch" signal for downstream consumers, distinct from real probe-executed outcomes such as `HYDRATION_FAIL`/`MIXED`.

## Library + version source-of-truth

| Probe          | Library      | Version source                                                        |
| -------------- | ------------ | --------------------------------------------------------------------- |
| `typeorm`      | TypeORM      | `node_modules/typeorm/package.json` at runtime                        |
| `sequelize`    | Sequelize    | `node_modules/sequelize/package.json` at runtime                      |
| `mikroorm`     | MikroORM     | `node_modules/@mikro-orm/core/package.json` at runtime                |
| `prisma`       | Prisma       | `node_modules/@prisma/client/package.json` at runtime                 |
| `mongoose`     | Mongoose     | `node_modules/mongoose/package.json` at runtime                       |
| `sqlalchemy`   | SQLAlchemy   | `sqlalchemy.__version__`                                              |
| `activerecord` | ActiveRecord | `ActiveRecord::VERSION::STRING`                                       |
| `hibernate`    | Hibernate    | `pom.xml` hibernate-core dependency version                           |
| `efcore`       | EF Core      | loaded `Microsoft.EntityFrameworkCore` assembly informational version |
