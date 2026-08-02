# Testing

This repo is a deterministic benchmark of object-graph hydration. Tests protect correctness and reproducibility, not wall-clock performance.

## Principles

- Tests live next to source: `foo.ts` → `foo.test.ts`. Run them with Node's built-in test runner via `tsx --test "src/**/*.test.ts"` (`npm test`). Do not introduce Jest, Mocha, or Vitest.
- Tests must be deterministic: no timing-based assertions, no network, no real filesystem outside `os.tmpdir()` or the project's `local/` dirs. Trace artifacts go to `logs/local/<run-id>/` only.
- Assert on hydration correctness and stable output — given the same seed and inputs, the same tree must come out. Cover stack-safety on deep/cyclic graphs (no depth-bounded recursion blowups).
- Do not assert on benchmark timings; they are environment-dependent.

## Layered validation

1. **Every task** — `npm test` + `npm run lint` (ESLint + encoding gate) + `npm run audit:ci` (audit gate, gates production deps only; dev-only reported, not gated). Never skip these.
2. **Algorithm / runner changes** — add or extend a colocated test for the changed behavior; confirm the experiment fingerprint still behaves as intended (AGENTS.md §7).
3. **Generator / config changes** — verify a regenerated dataset is byte-stable across re-runs with the same seed.

Match depth to what you touched, but never skip lint + test. Call out residual risk when a layer could not be exercised locally.
