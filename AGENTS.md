# Agent guidance

**Project:** populate-all-demo <br />
**Stack:** TypeScript / Node.js (executed via [tsx](https://tsx.is/)) <br />
**Test runner:** Node's built-in test runner (`node --test`) invoked through `tsx` <br />
**Supporting probes:** TypeScript + Python (SQLAlchemy) + Ruby (ActiveRecord) + Java (Hibernate) + C# (EF Core) <br />

Project-facing guidance for coding agents and reviewers. Contribution flow is in
[CONTRIBUTING.md](./CONTRIBUTING.md). Keep this file under 9,000 characters
(`npm run lint:agents`).

This is a public research repository. The committed `reference/` artifacts are the canonical
record of published findings; treat them as immutable historical data.

## Commands

- `npm ci`: reproducible install from `package-lock.json` (not `npm install`).
- `npm run generate`: produce test datasets (writes to `data/`, gitignored).
- `npm run experiment` / `npm run experiment:force`: run benchmarks (writes to `reports/`, gitignored).
- `npm test`: unit tests (trace logs to `logs/`, gitignored).
- `npm run lint`: ESLint. `npm run lint:docs`: markdownlint.
- `cd supporting-probes && npm ci && npm run probe:all`: the full supporting-probe suite.
  `mongoose` needs a reachable MongoDB (`MONGODB_URI`, default
  `mongodb://127.0.0.1:27017/supporting_probe_mongoose`). For the Python/Ruby/Java/.NET setup,
  use the commands in [`supporting-probes.yml`](./.github/workflows/supporting-probes.yml).

Don't change the `version` field in `package.json`, and don't add top-level dependencies to
either `package.json` without justification in the PR.

## Reference artifacts are immutable

`reports/reference/`, `logs/reference/`, `supporting-probes/results/reference/` and
`data/reference/` hold the canonical published results, one directory per major version
(`v1/`, `v2/`, …).

- **Never modify them in a PR.** Only a major release writes a new version directory, and a
  published version is frozen forever. `repo-config-guard` rejects PRs that touch them.
- Minor releases don't change results: they never re-run the experiment or touch `reference/`.
- Local runs write to gitignored `reports/local/<run-id>/`, `logs/local/<run-id>/` and
  `supporting-probes/results/local/<run-id>/`. CI uploads from `reports/` and `logs/` only.

## Determinism and reproducibility

Determinism and reproducibility are core requirements. If a change makes the same input produce
different output across re-runs, it is incorrect.

- **Seeded randomness only**, through `seedrandom`. Never `Math.random()` in paths that affect
  committed artifacts.
- **No wall-clock fields in the fingerprint** (`RunMetadata` in
  [`src/runner.ts`](./src/runner.ts)). It intentionally includes `manifest.generatedAt` to detect
  data regenerations.
- **Stable ordering:** sort directory contents and object keys before writing an artifact.
- **No environment leakage:** identical outputs on Linux and Windows for the same seeds and
  dependency versions.
- **The runtime is a measurement parameter, not a compatibility setting.** Node is pinned to
  exactly `22.22.3` ([`.nvmrc`](./.nvmrc) and every workflow), and CI runs on `ubuntu-24.04`.
  The v1 numbers were measured on that runtime. `engines` stays `>=22`, because that is the real
  code floor. Changing the runtime, or the supporting-probe dependencies, requires a new major
  reference version with regenerated numbers, never a routine bump.

## Architecture & coding standards

- **TypeScript:** `strict: true` (don't relax it); no `any` (use `unknown` and narrow); CommonJS
  (`"type": "commonjs"`); relative imports within `src/`, no deeper than `../../`.
- **Layout:** `src/` experiment code (runner, generator, algorithms, colocated tests); `scripts/`
  Node CLI helpers; `supporting-probes/` standalone multi-language probes with their own lockfile;
  `analysis/` the human-authored research reports; `reports/`, `logs/`,
  `supporting-probes/results/` output directories.
- **Tests:** `foo.ts` → `foo.test.ts`, Node's built-in runner via `tsx --test`. No other test
  framework. Deterministic: no timing assertions, no network, no filesystem outside `os.tmpdir()`
  or the `local/` dirs.
- **Hygiene:** comments only for non-obvious logic or external references, never changelog notes.
  No stray `console.log`; the runner's structured stdout is intentional.
- **CLI tables** (`src/runner.ts`): fit the terminal by display width, truncate with an explicit
  ellipsis, never hardcode column widths. The table is a view; full-precision numbers live in the
  JSON artifacts.
- **Config:** [`src/generate-config.json`](./src/generate-config.json) defines dataset tiers,
  seeds and sizing. It is part of the experiment definition. No hardcoded paths; use
  `path.join(...)` from the project root.
- **Lockfiles are authoritative.** `npm ci` only; don't delete lockfiles or run `npm audit fix`.

## Security constraints

- No secrets, API keys or tokens anywhere in the repo.
- No outbound network calls from the runner, generator or TypeScript probes. The other probes
  connect only to local SQLite/MongoDB as their scripts define.
- No telemetry or phone-home behaviour.

## Docs conventions

- In-repo paths in Markdown are clickable links; `docs-lint` checks they resolve.
- Markdown files are limited to an allowlist,
  [`.github/docs-policy.yml`](./.github/docs-policy.yml), which the `docs-policy` check enforces.
  Editing an allowed file is fine. Put design notes in the PR or an issue rather than a new
  `.md` file.
