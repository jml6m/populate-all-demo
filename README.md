# populate-all-demo

This repository demonstrates how to fully populate a partially hydrated object graph — including graphs with cycles — using deterministic, stack-safe algorithms. It benchmarks four approaches across five dataset tiers and measures both hydration correctness and downstream consumer viability.

## Prerequisites

- [Node.js](https://nodejs.org/) v20 or later
- npm (included with Node.js)
- MongoDB (only required for the Mongoose supporting probe)

For supporting probe prerequisites and runtime setup details (including `MONGODB_URI` for the Mongoose probe), see [`supporting-probes/README.md`](./supporting-probes/README.md). The main experiment and development checks in this README require only Node.js + npm.

## Getting started

```bash
git clone https://github.com/jml6m/populate-all-demo.git
cd populate-all-demo
npm install
```

## Running the experiment

**Step 1 — generate the test datasets:**

```bash
npm run generate
```

This writes the input and answer files for all dataset tiers to the `data/` directory. The generator is idempotent; re-running it will skip tiers that are already up to date.

### How `npm run generate` works

`npm run generate` reads `src/generate-config.json` (seeds, dataset tier sizes, RNG configuration) and produces deterministic dataset YAML files in `data/<tier>/`. Each filename is content-addressed: it includes a hash of the file's contents. A `data/manifest.json` index records every file with its content hash and a generation timestamp.

The script is idempotent — re-running it with the same config produces the same files and skips work that's already done. Use `npm run generate:force` to regenerate from scratch.

The `data/` directory is gitignored on local development. The release workflow snapshots a copy into `data/reference/v1/`, `data/reference/v2/`, etc. for each tagged release, so published findings are accompanied by the exact data files they were measured against.

**Step 2 — run the experiment:**

```bash
npm run experiment
```

The runner benchmarks four population algorithms across five dataset tiers (`acyclic-control`, `basic`, `medium`, `stress`, `extreme`), verifies correctness with two independent comparers, and runs consumer probes on each passing result. Results are printed to the console and saved in `reports/local/<run-id>/`, and test trace logs are written in `logs/local/<run-id>/`.

**Optional — force a re-run even if results are already cached:**

```bash
npm run experiment:force
```

Use `npm run clean` to remove local run outputs (`reports/local/`, `logs/local/`, `supporting-probes/results/local/`) plus `data/` and `dist/`.

For supporting probe execution details (`probe:ts`, `probe:all`, prerequisites, and JSON outputs), see [`supporting-probes/README.md`](./supporting-probes/README.md).

```bash
npm run clean
```

## Development commands

- `npm run lint` — ESLint on `src/**/*.ts` (zero errors required).
- `npm run build` — TypeScript compile to `dist/`.
- `npm test` — Node test runner against `src/**/*.test.ts`.
- `npm run npm:reinstall` — clean reinstall of root + supporting-probes dependencies (deletes `node_modules` and runs `npm ci` in both). Useful when lockfile changes or after pulling a branch with dep updates.

For supporting probe execution details (`probe:ts`, `probe:all`, prerequisites, and JSON outputs), see [`supporting-probes/README.md`](./supporting-probes/README.md).

## Releases

- **v1.0.0** (initial release) — first canonical reference dataset; baseline algorithm benchmarks.
- **v1.0.1** (patch) — corrected the MikroORM supporting-probe to verify cycle serialization on the true reconstructed graph rather than `Collection.toJSON()`'s flattened projection. Reference data for `supporting-probes/results/reference/v1/mikroorm.json` was updated; benchmark/algorithm results are unchanged.

See [docs/ADMIN.md §Release procedure](./docs/ADMIN.md#release-procedure) for canonical release workflow and artifact details.

## Artifact directories

- Local/unofficial outputs are written to:
  - `reports/local/<run-id>/`
  - `logs/local/<run-id>/`
  - `supporting-probes/results/local/<run-id>/`
- Canonical tagged-release artifacts belong in versioned immutable directories:
  - `reports/reference/v1/`, `reports/reference/v2/`, ...
  - `logs/reference/v1/`, `logs/reference/v2/`, ...
  - `supporting-probes/results/reference/v1/`, `supporting-probes/results/reference/v2/`, ...
  - `data/reference/v1/`, `data/reference/v2/`, ...
- Rules for editing these directories:
  - `*/local/*` is developer output and is intentionally not committed (`reports/`, `logs/`, `supporting-probes/results/`, and `data/` local output).
  - `*/reference/*` is canonical release evidence (`reports/`, `logs/`, `supporting-probes/results/`, and `data/`); do not edit existing versioned contents (`v1/`, `v2/`, ...) in normal development.

## Further reading

- [Experiment Analysis](./analysis/EXPERIMENT_ANALYSIS.md) — the primary report: problem definition, how the experiment is structured, what the five dataset tiers test, and the full results comparing all four algorithms across hydration correctness and downstream consumer viability.
- [Ecosystem Research](./analysis/ECOSYSTEM_RESEARCH.md) — extended supporting material: the formal O(V+E) complexity proof, in-depth analysis of how major ORMs and data frameworks handle cyclic graphs across backend, serialization, and frontend layers, and a detailed input-validity taxonomy.
