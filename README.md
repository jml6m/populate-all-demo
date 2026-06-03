# populate-all-demo

This repository demonstrates how to fully populate a partially hydrated object graph — including graphs with cycles — using deterministic, stack-safe algorithms. It benchmarks four approaches across five dataset tiers and measures both hydration correctness and downstream consumer viability.

## Prerequisites

- [Node.js](https://nodejs.org/) v20 or later
- npm (included with Node.js)

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

```bash
npm run clean
```

## Artifact directories

- Local/unofficial outputs are written to:
  - `reports/local/<run-id>/`
  - `logs/local/<run-id>/`
  - `supporting-probes/results/local/<run-id>/`
- Canonical tagged-release artifacts belong in versioned immutable directories:
  - `reports/reference/v1/`, `reports/reference/v2/`, ...
  - `logs/reference/v1/`, `logs/reference/v2/`, ...
  - `supporting-probes/results/reference/v1/`, `supporting-probes/results/reference/v2/`, ...
- Rules for editing these directories:
  - `*/local/*` is developer output and is intentionally not committed.
  - `*/reference/*` is canonical release evidence; do not edit existing versioned contents (`v1/`, `v2/`, ...) in normal development.
  - `npm run clean` is for local cleanup only and is not part of CI workflows, so CI artifacts can be inspected after each run.

## Further reading

- [Experiment Analysis](./analysis/EXPERIMENT_ANALYSIS.md) — the primary report: problem definition, how the experiment is structured, what the five dataset tiers test, and the full results comparing all four algorithms across hydration correctness and downstream consumer viability.
- [Ecosystem Research](./analysis/ECOSYSTEM_RESEARCH.md) — extended supporting material: the formal O(V+E) complexity proof, in-depth analysis of how major ORMs and data frameworks handle cyclic graphs across backend, serialization, and frontend layers, and a detailed input-validity taxonomy.
