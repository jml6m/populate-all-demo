# Fast Iteration

Some problems need a quick probe before they belong in tests or the runner. Use short-lived scripts to learn fast, then promote or delete.

## When to reach for a scratch script

- You need to exercise one hydration approach or graph-traversal function in isolation.
- You want to see what the generator emits for a single dataset tier without running the full experiment.
- A bug only reproduces for a specific seed or graph shape.

Prefer a 20-line probe over guessing from static reading.

## Conventions

- Run probes with `tsx`: `npx tsx scripts/scratch/<file>.ts`. Keep reusable probes in `scripts/scratch/`.
- Import from `src/` instead of copying algorithm logic inline.
- Write any throwaway output under the gitignored `reports/local/`, `logs/local/`, or `data/local/` dirs — never under `reference/`.
- Honor determinism: route all randomness through the seeded RNG, never `Math.random()` (AGENTS.md §7).
- Do not pull in new top-level dependencies just to debug.

## Promoting to durable automation

Promote a probe when the check will be re-run after future changes and is stable enough to assert on:

1. Move it into a colocated `*.test.ts` next to the source it covers.
2. Add an `npm run` script only if it will be used routinely.
3. Remove the scratch original.

## What not to do

- Do not hardcode absolute paths or secrets in probes.
- Do not leave debug `console.log` in committed `src/` code (the runner's intentional progress output stays).
- Do not add permanent `package.json` scripts for one-off investigations.
