# populate-all-demo

This repository demonstrates how to fully populate a partially hydrated object graph — including graphs with cycles — using deterministic, stack-safe algorithms. It benchmarks four approaches across five dataset tiers and measures both hydration correctness and downstream consumer viability.

## Prerequisites

- [Node.js](https://nodejs.org/) v18 or later
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

The runner benchmarks four population algorithms across five dataset tiers (`acyclic-control`, `basic`, `medium`, `stress`, `extreme`), verifies correctness with two independent comparers, and runs consumer probes on each passing result. Results are printed to the console and saved as JSON reports in the `reports/` directory.

**Optional — force a re-run even if results are already cached:**

```bash
npm run experiment:force
```

## Further reading

- [Experiment Analysis](./analysis/EXPERIMENT_ANALYSIS.md) — problem definition, ecosystem context, experiment design, results, and interpretation.
- [Ecosystem Research](./analysis/ECOSYSTEM_RESEARCH.md) — extended technical detail: O(V+E) complexity proof, ORM deep-dives, serialization boundary taxonomy, and cross-stack pattern unification.
