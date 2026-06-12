# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repository.

## Start here

The authoritative agent guidelines for this repo live in **[AGENTS.md](./AGENTS.md)** — read it first and follow it. It is the source of truth for the project's purpose, the determinism/idempotency requirements, the reference-artifact immutability rules, the release policy, and the protected-path list. If anything here conflicts with `AGENTS.md`, `AGENTS.md` wins. This file does not duplicate it.

Task-specific protocols live in **[.grok/rules/](./.grok/rules/)** and apply to Claude too:

- `issue-workflow.md` — GitHub issues are the planning source of truth.
- `fast-iteration.md` — use short-lived probe scripts to learn fast, then promote or delete.
- `testing.md` — what to test (deterministic hydration behavior via Node's test runner).
- `session-validation.md` — the mandatory end-of-task validation gate.

## Repo quick facts

- `populate-all-demo` — a public research repo benchmarking deterministic, stack-safe object-graph hydration (traversing directed cyclic graphs without depth boundaries) across approaches and datasets.
- CommonJS TypeScript (`"type": "commonjs"`), executed via [tsx](https://tsx.is/); strict mode, no `any`.
- `src/` holds the runner, generator, algorithms, and colocated `*.test.ts` tests. `scripts/` holds CommonJS Node CLI helpers. `supporting-probes/` is a self-contained multi-language probe suite.
- **Determinism is a hard requirement.** Seeded RNG only, stable ordering, no wall-clock fields in fingerprints — see AGENTS.md §7.

## Commands

| Command | Purpose |
|---|---|
| `npm test` | Node's built-in test runner via `tsx --test "src/**/*.test.ts"`. Run after every change. |
| `npm run lint` | ESLint over `src/**/*.ts`, then the encoding gate. |
| `npm run lint:encoding` | Fails on non-UTF-8 / BOM / CRLF / control chars in tracked files. |
| `npm run audit:ci` | Fails only on critical/high advisories (moderate/low ignored). |
| `npm run generate` / `generate:force` | Produce test datasets (writes to gitignored `data/`). |
| `npm run experiment` / `experiment:force` | Run benchmarks (writes to gitignored `reports/`). |
| `npm run npm:reinstall` | Clean reinstall, then the audit gate. |
| `npm run git:pull` | Full `fetch --all --prune` + fast-forward pull. |

## Conventions

Follow the author's standing coding conventions: comments only where they earn their place (no changelog-style "updated/refactored" comments); targeted edits over full-file rewrites. Per AGENTS.md, agents never bump the `package.json` version, never trigger or modify `release.yml` (it requires a `release-infra` label), and never publish to npm — this package is intentionally not on the registry. Reference artifacts under `reference/` are frozen. Only create commits/pushes when explicitly instructed and the environment supports it (see `.grok/rules/session-validation.md`).

## Before handing work back

Run `npm test` and `npm run lint`; report pass/fail explicitly per `.grok/rules/session-validation.md`. Do not claim a check passed unless it actually ran.
