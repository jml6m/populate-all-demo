# Agent & AI Protocols (All Agents)

**Project:** populate-all-demo <br />
**Stack:** TypeScript / Node.js (executed via [tsx](https://tsx.is/)) <br />
**Test Runner:** Node's built-in test runner (`node --test`) invoked through `tsx` <br />
**Supporting Probes:** TypeScript + Python (SQLAlchemy) + Ruby (ActiveRecord) + Java (Hibernate) + C# (EF Core) <br />

This document defines the operational parameters, architectural standards, and safety protocols for all AI agents working within this repository.

> **Single Source of Truth**: This document is the authoritative reference for all coding standards, architecture rules, and project policies in this repository. If there is a conflict between this document and any other file, `AGENTS.md` takes precedence.

> **Public Research Repo**: This repository is currently private and will be made public after the v1 release ships. The committed `reference/` artifacts are the canonical record of published findings. Treat them as immutable historical data — see §3 and §6 for the exact constraints. Reproducibility, idempotency, and clear documentation are the top priorities.

---

## Critical Protocols (Read First)

### 1. The "Three Strike" Rule (Loop Prevention)

For unsupervised runs, if you attempt to fix an error and the **same** error persists after **3 attempts**:

- **STOP** trying to fix it.
- Revert changes to the last functioning state.
- Comment out the breaking test/code with `// FIXME: Agent worker failed`.
- Log the failure and move to the next task.

### 2. GitHub Issue Awareness

Before starting work, check the open issues in this repository for related tasks.

- **Reference Issues:** If your work addresses or relates to an existing issue, reference it in your PR/Commit (e.g., `fixes #123`).
- **Duplicate Prevention:** When suggesting deferred work, check if an issue already exists before recommending a new one.

### 3. Command Execution Safety

**STRICTLY PROHIBITED:**

- **Triggering or modifying `.github/workflows/release.yml`** — official releases are an admin-only manual flow. Never invoke it, never push commits that change it without an explicit `release-infra` label on the PR (see §5).
- **Modifying any file under `reports/reference/`, `logs/reference/`, or `supporting-probes/results/reference/`** — these are the canonical published artifacts (see §6).
- **Bumping the `version` field in `package.json`** — version bumps happen only inside the official release workflow. Do not edit this field manually for any reason.
- **Modifying any past-version reference directory** (e.g. `reports/reference/v1/` once `v2` exists). Past versions are frozen in source control forever.
- **Adding new top-level dependencies** to either `package.json` without explicit approval. Dev-only deps require justification in the PR description.
- `git push` — Agents do not push to remote directly.
- `git commit` — Avoid creating commits unless your execution environment explicitly supports agent-authored commits and you have been instructed to do so.
- `npm publish` — This package is not published to the registry.
- `npm install <pkg>` without explicit instruction. Use `npm ci` for reproducible installs from the lockfile.

**Standard Commands:**

- `npm ci` — reproducible install from `package-lock.json` (preferred over `npm install`).
- `npm run generate` — produce test datasets (writes to `data/`, gitignored).
- `npm run experiment` / `npm run experiment:force` — run benchmarks (writes to `reports/`, gitignored).
- `npm test` — run unit tests (writes trace logs to `logs/`, gitignored).
- `npm run lint` — run ESLint.
- `cd supporting-probes && npm ci && npm run probe:ts` — run the TypeScript probe suite (`typeorm`, `sequelize`, `mikroorm`, `prisma`, `mongoose`).
- `cd supporting-probes && npm ci && npm run probe:all` — run the full supporting-probe suite (TypeScript + Python + Ruby + Java + .NET probes).
- For Python/Ruby/Java/.NET environment setup and troubleshooting, use the exact commands from `.github/workflows/supporting-probes.yml` (these probes are included in `npm run probe:all` once prerequisites are installed).
### 4. Code Review & PR Interaction

The agent **MUST** respond to all comments from the **primary reviewer** (the project admin, `@jml6m`) without requiring an explicit `@`-mention. A "Request changes" review on the PR is sufficient signal that every unresolved comment needs action.

- **Prohibited Responses:**
  - Passive acknowledgments (e.g., "Acknowledged", "Noted", "Comment read", "Will fix").
- **Required Resolution:**
  - **Act:** Push a code change to resolve the feedback.
  - **Discuss:** If you disagree with the suggestion, state the reason why or propose an alternate approach. Never silently ignore a comment.
- **Threaded comments / replies-to-replies:** If the project admin replies to a comment thread (including a thread originally started by an agent), the agent **MUST** treat that reply as new actionable feedback and respond per the rules above. Do not consider a thread "closed" until the admin explicitly marks it resolved or merges the PR.

#### Agent-to-Agent Boundary Rules

- **Own Comments Only:** If a PR review comment was authored by an AI agent (e.g., `copilot-pull-request-reviewer[bot]`, `github-actions[bot]`), **only the agent that originally created the comment** may respond to follow-ups on that thread.
- **No Cross-Agent Replies:** An agent **MUST NOT** reply to another agent's comment unless explicitly tagged with `@` in that comment.
- **Human Priority:** Comments from `@jml6m` always take priority. If the project admin replies to any thread (including one started by an agent), the addressed agent **MUST** respond.
- **Bot Threads = Read-Only:** Treat comment threads started by other bots/agents as read-only context. You may use the information, but do not post replies.

#### Known AI Agent Identities

- `copilot-pull-request-reviewer[bot]` — GitHub Copilot PR Review
- `github-actions[bot]` — CI/CD automation

### 5. Versioning & Release Policy

This repo uses **major-version-only** semver releases (`1.0.0`, `2.0.0`, `3.0.0`, …). There are no minor or patch releases. Each release is a deliberate, manual act by the project admin.

- **Agents NEVER bump the version field in `package.json`.** Version bumps happen exclusively inside `.github/workflows/release.yml`, which only the project admin may trigger.
- **Agents NEVER trigger `release.yml`.**
- **Agents NEVER create git tags.**
- **Agents NEVER create or modify GitHub Releases.**
- **CI workflow modifications** (`.github/workflows/*.yml`) do not require a `ci-change` label. The `release.yml` workflow specifically requires the `release-infra` label.
- **Agents MAY** modify probe scripts, runner code, generation code, and analysis docs during the development cycle between releases. Such changes will be picked up by the next admin-triggered release.

### 6. Reference Artifact Immutability

The `reference/` directories under `reports/`, `logs/`, and `supporting-probes/results/` contain the canonical published results for each tagged release. They are organized by version (`v1/`, `v2/`, …).

- **Past versions are frozen.** Once `v1/` is committed, no PR may modify any file under `reports/reference/v1/`, `logs/reference/v1/`, or `supporting-probes/results/reference/v1/`. Same rule for every subsequent version.
- **The current in-development version's reference dir does not yet exist** until the next release workflow runs. Do not pre-create it.
- **Local runs** write benchmark output under `reports/` (gitignored). Tests and trace artifacts write under `logs/` (gitignored).
- **CI runs** (non-release workflows) must upload artifacts from `reports/` and/or `logs/` only; they must never write under any `reference/` path.
CI includes a dedicated `repo-config-guard` workflow that enforces reference-artifact immutability and the `release-infra` label requirement for `release.yml` changes.

### 7. Idempotency-First Design

This is a research repo. **Determinism and reproducibility are core requirements.** When writing or modifying experiment/runner/probe code:

- **Seeded randomness only.** All randomness must flow through a seeded RNG (currently `seedrandom`). Never use `Math.random()` directly in code paths that affect committed artifacts.
- **No run timestamps in fingerprints/hashes.** Do not add `runAt` or other wall-clock fields to the experiment fingerprint; note that the current fingerprint intentionally includes `manifest.generatedAt` to detect data regenerations.
- **Stable file ordering.** When iterating directory contents or object keys to write into a committed artifact, sort first. Otherwise hashes drift across OSes.
- **No environment leakage.** Tests and the experiment runner must produce identical outputs on Linux and Windows given the same seeds and dependency versions. If platform-specific paths or behavior are unavoidable, isolate them and document.

If a change you make causes the same input to produce different output across re-runs, that change is incorrect — fix it before opening the PR.

---

## Architecture & Coding Standards

### 1. TypeScript Practices (Strict)

- **Strict mode required.** `tsconfig.json` enforces `strict: true`; do not relax this.
- **No `any`.** If a type is genuinely unknown, use `unknown` and narrow. Use `// eslint-disable-next-line` only with a comment explaining why.
- **Module system: CommonJS.** `package.json` declares `"type": "commonjs"`. Do not switch to ESM without admin approval — it cascades into how `tsx`, the test runner, and Node's `require` interop behave.
- **Imports: relative paths within `src/`.** No path aliases are configured; do not introduce them in this PR cycle.
- **No deep relative paths beyond `../../`.** If you find yourself writing `../../../`, the file probably belongs in a different location.

### 2. Code Organization

- **`src/`** — main experiment code (runner, generator, algorithms, utilities, tests colocated).
- **`scripts/`** — Node CLI helpers (no TypeScript build step required; CommonJS only).
- **`supporting-probes/`** — standalone probes in multiple languages. Self-contained `package.json` and lockfile. Probe scripts may be modified during development cycles.
- **`analysis/`** — human-authored research reports (`.md`). Edits to these are allowed during development; they are the prose layer that links to `reference/` artifacts.
- **`reports/`, `logs/`, `supporting-probes/results/`** — output dirs. See §6.

### 3. Tests

- **Test files live next to source:** `foo.ts` → `foo.test.ts`.
- **Use Node's built-in test runner**, invoked via `tsx --test "src/**/*.test.ts"`. Do not introduce Jest, Mocha, Vitest, or any other test framework.
- **Tests must be deterministic.** No timing-based assertions, no network, no real filesystem outside of `os.tmpdir()` or the project's `local/` dirs.
- **Trace artifacts** written by tests go to `logs/local/<run-id>/` only.

### Coding Hygiene (Strict)

- **Comments**: Use comments _only_ for complex logic, non-obvious invariants, or pointing at external references (issue numbers, papers). **Do NOT** add metadata comments like `// Refactored`, `// New functionality`, or `// Added by agent`. Use Git history for temporal context.
- **No `console.log` left behind in committed code** unless it is part of the runner's intentional human-readable output (the runner does print structured progress to stdout — that's by design and stays). Test scaffolding `console.log` must be removed before commit.
- **No new top-level dependencies** without justification in the PR description (see §3).

---

## Configuration (SSoT)

- **Generation config:** `src/generate-config.json` is the single source of truth for dataset tier definitions, seeds, and sizing. Changes here are part of the experiment definition; treat with care.
- **Run-time fingerprinting:** see `RunMetadata` in `src/runner.ts`. The fingerprint determines whether a re-run is needed. Do not add wall-clock fields to it.
- **No hardcoded paths.** Use `path.join(...)` and resolve from the project root or a passed-in base dir.

---

## Package Ecosystem

- **Top-level (`/package.json`):** TypeScript, tsx, ESLint, Prettier, seedrandom, yaml. See `package.json` for resolved versions.
- **Supporting-probes (`/supporting-probes/package.json`):** ORM clients (TypeORM, Sequelize, MikroORM, Prisma, Mongoose) plus their drivers. See that file for versions.
- **Lockfiles are authoritative.** `npm ci` installs exactly what the lockfile says. Do not delete lockfiles or run `npm audit fix`.

---

## Project Security & Context Constraints

### Excluded / Protected Paths

The following paths are **agent-protected**. Do not modify without explicit instruction from the project admin in the PR's problem statement:

1. **`.github/workflows/release.yml`** (when it exists) — the official release workflow. Requires `release-infra` label on the PR.
2. **All other `.github/workflows/*.yml`** — no `ci-change` label is required.
3. **`.github/CODEOWNERS`** (when it exists) — admin only.
4. **`.github/branch-protection.json`** (when it exists) — admin only.
5. **`reports/reference/v<N>/`, `logs/reference/v<N>/`, `supporting-probes/results/reference/v<N>/`** — frozen per §6.
6. **`package.json` `version` field** — admin only, modified by the release workflow.
7. **`AGENTS.md`** (this file) — admin approval required for changes.

### Interaction Guidelines

- **No Hardcoded Secrets:** Never hardcode secrets, API keys, or tokens. (This repo currently has none, and that is the desired state.)
- **No Network Calls in Core Code:** The experiment runner, generator, and TypeScript probes must not make outbound network calls. The non-Node probes may connect to a local SQLite/MongoDB only as defined by their existing scripts.
- **No Telemetry:** Do not add analytics, telemetry, or any phone-home behavior anywhere in the codebase.
