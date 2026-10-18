# populate-all-demo

This repository demonstrates how to fully populate a partially hydrated object graph — including graphs with cycles — using deterministic, stack-safe algorithms. It benchmarks four approaches across five dataset tiers and measures both hydration correctness and downstream consumer viability.

## Prerequisites

- [Node.js](https://nodejs.org/) v22 or later; use the exact version in [`.nvmrc`](./.nvmrc), which is the one CI runs
- npm (included with Node.js)

That's all the experiment and the checks need. The supporting probes need more; see [`supporting-probes/README.md`](./supporting-probes/README.md).

## Getting started

```bash
git clone https://github.com/jml6m/populate-all-demo.git
cd populate-all-demo
npm ci
```

`npm ci` installs exactly the versions in `package-lock.json`, so your runs use the same dependencies as the published ones, and it never rewrites the lockfile. To add or change a dependency, use `npm install <pkg>`, which updates both files. If `package.json` is edited by hand, `npm ci` stops with an error until `npm install` brings the lockfile back in step.

## Running the experiment

**Step 1 — generate the test datasets:**

```bash
npm run generate
```

This writes the input and answer files for all dataset tiers to the `data/` directory. The generator is idempotent; re-running it will skip tiers that are already up to date.

### How `npm run generate` works

`npm run generate` reads `src/generate-config.json` (seeds, dataset tier sizes, RNG configuration) and produces deterministic dataset YAML files in `data/<tier>/`. Each filename is content-addressed: it includes a hash of the file's contents. A `data/manifest.json` index records every file with its content hash and a generation timestamp.

The script is idempotent — re-running it with the same config produces the same files and skips work that's already done. Use `npm run generate:force` to regenerate from scratch.

The `data/` directory is gitignored on local development. Each major release snapshots a copy into `data/reference/v<N>/` (`v1/`, `v2/`, …), so published findings are accompanied by the exact data files they were measured against. Minor releases don't change the data.

**Step 2 — run the experiment:**

```bash
npm run experiment
```

The runner benchmarks four population algorithms across five dataset tiers (`acyclic-control`, `basic`, `medium`, `stress`, `extreme`), verifies correctness with two independent comparers, and runs consumer probes on each passing result. Results are printed to the console and saved in `reports/local/<run-id>/`, and test trace logs are written in `logs/local/<run-id>/`.

**Optional — force a re-run even if results are already cached:**

```bash
npm run experiment:force
```

## Development

CI runs lint, circular-import, unit-test and Markdown checks on every pull request. To run them yourself, see [Checks](./CONTRIBUTING.md#checks).

## Releases

- **v1.0.0** (initial release) — first canonical reference dataset; baseline algorithm benchmarks.
- **v1.0.1** (patch) — corrected the **MikroORM** supporting-probe to verify cycle serialization on the true reconstructed graph rather than `Collection.toJSON()`'s flattened projection. Reference data for [MikroORM results](./supporting-probes/results/reference/v1/mikroorm.json) were updated; benchmark/algorithm results are unchanged.
- **v1.0.2** (patch) — corrected the ecosystem hydration conclusions: Only **MikroORM** and **Hibernate** reach schema-driven acyclic full hydration — and even these are provisional. **EF Core** and **TypeORM** cannot construct the eager query at all; **SQLAlchemy** and **ActiveRecord** resolve the graph only through N+1 traversal queries; the remaining libraries under-hydrate. The §2 comparison was reworked into an explicit cyclic/acyclic hydration matrix. Core two-pass algorithm and benchmark results are unchanged.
- **v1.0.3** (patch) — Process & Infrastructure Overhaul. Repository automation and governance were streamlined for maintainers.
- **v1.1.0** (minor, results unchanged) — the major/minor release model, the exact Node version pin, CI gates, `CONTRIBUTING.md` and the agent-file length check.
- **v1.2.0** (minor, results unchanged) — toolchain and GitHub Actions updates (ESLint 10), lint errors and circular imports fail CI, a guide for contributing from a fork, and documentation brought up to date.

Releases are numbered `vX.Y`. The git tag and the `package.json` version carry `X.Y.0`, because npm and semver need three parts, and the last digit is always 0. v1.0.1–v1.0.3 were patch releases from before this scheme.

Major releases publish a new reference set (`reference/v<N>/`) and are the only releases that change results. From v1.1.0, minor releases carry fixes and infrastructure only; they never re-run the experiment or touch `reference/`. See [`.github/workflows/release.yml`](./.github/workflows/release.yml).

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
- `local/` output is gitignored. The `reference/` sets are never edited ([research contributions](./CONTRIBUTING.md#research-contributions)).

## Further reading

- [Experiment Analysis](./analysis/EXPERIMENT_ANALYSIS.md) — the primary report: problem definition, how the experiment is structured, what the five dataset tiers test, and the full results comparing all four algorithms across hydration correctness and downstream consumer viability.
- [Ecosystem Research](./analysis/ECOSYSTEM_RESEARCH.md) — extended supporting material: the formal O(V+E) complexity proof, in-depth analysis of how major ORMs and data frameworks handle cyclic graphs across backend, serialization, and frontend layers, and a detailed input-validity taxonomy.
