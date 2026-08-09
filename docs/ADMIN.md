# Admin Runbook — populate-all-demo

Personal operational notes for the project administrator. Not user-facing.

## Required status checks, label rules, and tag rules

This file documents the project-specific release guardrails, not the GitHub.com
ruleset configuration.

- `repo-config-guard.yml` should be a required status check on pull requests to
  `main` because it enforces the two release-safety rules that matter here:
  - PRs must not touch `reports/reference/`, `logs/reference/`,
    `supporting-probes/results/reference/`, or `data/reference/`
  - PRs that change `.github/workflows/release.yml` must carry the
    `release-infra` label
- `docs-lint.yml` should be a required status check on pull requests to `main`.
  It runs `lychee` (link checking, including internal anchor verification) and
  `markdownlint-cli2` over all committed `.md` files. This catches broken
  cross-doc links, missing anchors, malformed tables, and other markdown
  structural issues that can cause rendering problems on GitHub.
- `release-infra` is the only release-related label documented here. It is only
  for PRs that change the release workflow definition itself.

## Reference data layout

The repo holds canonical experimental artifacts under four trees:

- `reports/reference/v<N>/` — the canonical benchmark outcomes for the tagged
  release across the experiment's dataset tiers
- `logs/reference/v<N>/` — the canonical trace evidence for how that release's
  experiment run behaved
- `supporting-probes/results/reference/v<N>/` — the canonical cross-framework
  supporting-probe results captured for that release
- `data/reference/v<N>/` — the input dataset YAML files (and their manifest)
  consumed by the experiment for that release — published so readers can
  reproduce findings exactly

Where `<N>` is a major version (1, 2, 3, …). Versioned directories are created
by the release workflow.

## The repo-config-guard workflow

`.github/workflows/repo-config-guard.yml` runs on every pull request against `main`
and enforces two rules:

1. **Reference-data immutability** — no PR may add, modify, delete, or rename
   anything under `reports/reference/`, `logs/reference/`, or
   `supporting-probes/results/reference/`, or `data/reference/`. Only the
   release workflow (running on `workflow_dispatch` from `main`, never on
   `pull_request`) may write there.

2. **`release.yml` change requires `release-infra` label** — any PR adding,
   modifying, deleting, or renaming `.github/workflows/release.yml` must have the
   `release-infra` label applied. This forces explicit acknowledgment for
   release-infrastructure changes.

The guard is a required status check on `main`. PRs cannot merge without it
passing.

If the guard ever blocks a legitimate change, the override is to apply the
`release-infra` label (for `release.yml` changes only). There is no override for
reference-data changes — those must go through the release workflow.

## Common admin commands

Local smoke test after pulling main:

```bash
git pull
npm ci
npm run lint
npm run build
npm test
npm run lint:docs
```

Docs-only pre-PR sanity check: `npm run lint:docs` (requires `lychee` on your `PATH`; `brew install lychee` or `cargo install lychee`)

[`docs-lint.yml`](../.github/workflows/docs-lint.yml) runs the same lychee/markdownlint checks on github.com and uses `lycheeverse/lychee-action@v2` for CI lychee installation.

Dependency hard reset (root + supporting-probes):

```bash
npm run npm:reinstall
```

Run all supporting probes locally (silent by default):

```bash
cd supporting-probes
npm ci
npm run probe:all
```

Run with verbose ORM query logging:

```bash
PROBE_VERBOSE=1 npm --prefix supporting-probes run probe:all
```

Preview whether the current PR branch would fail the reference-data guard. Run
this from a local checkout of the PR branch after fetching the latest
`origin/main`. No output means the guard's reference-data check should pass:

```bash
git fetch origin main:refs/remotes/origin/main
git diff --no-renames --name-only --diff-filter=AMDR origin/main...HEAD | grep -E '^(reports|logs|supporting-probes/results|data)/reference/' || true
```

## Release procedure

Releases are major-first (`v1`, `v2`, `v3`, …) with optional patch hotfixes
(`v1.0.1`, `v1.0.2`, …). The release workflow is the only automated process
that may write to the `reference/` trees.

### What the workflow does

`.github/workflows/release.yml` runs on `workflow_dispatch` only. Steps, in order:

1. Computes the next version from `package.json` based on `release_type`:
   - `major` (default): `N.0.0` → `N+1.0.0`, release dir `v<N+1>`
   - `patch`: `N.0.P` → `N.0.(P+1)`, reuses existing release dir `v<N>`
2. For `major`, aborts if any of `reports/reference/v<N>/`, `logs/reference/v<N>/`,
   `supporting-probes/results/reference/v<N>/`, or `data/reference/v<N>/`
   already exist on `main`. Patch mode skips this check.
3. Sets up Node, Python, Ruby, Java 21, and .NET 8 runtimes.
4. Runs `npm ci`, `npm run lint`, `npm run build`, `npm test`, `npm run generate`,
   `npm run experiment`, then installs probe deps and runs `npm run probe:all`.
5. For `major`, aborts if the experiment fingerprint matches the previous release's
   `experiment-run.json` fingerprint (no experiment-relevant changes). Patch mode skips this check.
6. Copies local outputs into reference trees:
   - `major`: copies reports, logs, probes, and data into new `reference/v<N>/`
   - `patch`: replaces existing `reports/logs/supporting-probes/results/data/reference/v<N>/` assets in place
7. Writes/updates `reports/reference/v<N>/manifest.json` (tag, releasedAt, runId, lockfile hashes).
8. Bumps `package.json` to the computed SemVer via `npm version`.
9. Commits and pushes directly to `main` using a short-lived token from a
   GitHub App that has Always-allow bypass on `main-require-review`.
   **Current (interim):** **jml6m-bot** via `APP_ID` / `APP_PRIVATE_KEY`
   (secrets already on this repo). **Target:** **jml6m-version-bot** via
   `VERSION_BUMP_APP_ID` / `VERSION_BUMP_APP_PRIVATE_KEY`, with that App as the
   sole Always-allow actor; jml6m-bot then authors PRs only. Do not dispatch a
   release until the secrets named in `release.yml` are non-empty — empty
   `app-id` fails mint with `[@octokit/auth-app] appId option is required`.

End-to-end runtime is roughly 5–10 minutes including polyglot setup.

### Dispatching a release

1. On a fresh local checkout, confirm `main` is in a releasable state:

   ```bash
   git checkout main
   git pull --ff-only
   npm ci
   npm run lint
   npm run build
   npm test
   ```

2. On github.com, navigate to **Actions → Release → Run workflow**, select
   `main`, and choose:
   - `release_type=major` for a new canonical major release
   - `release_type=patch` for a probe/data hotfix within the current major
3. Watch the run log. Successful completion ends with `✅ Pushed release v<N>.0.0 to main.` (major) or `✅ Pushed release v<N>.0.<P> to main.` (patch).

### Tagging the release after the workflow merges

Tagging is intentionally manual — the release isn't "official" until the admin
tags the resulting commit. Choose one method.

**CLI (preferred):**

```bash
git checkout main
git pull --ff-only
git tag v<N>.0.0
git push origin v<N>.0.0
```

(Replace with the actual release tag, e.g. `v1.0.0` or `v1.0.1`.)

### Patch-release procedure (supporting-probe/doc hotfixes)

Use `release_type=patch` only when fixing interpretation-critical defects without changing the experiment fingerprint. Example: `v1.0.1` was dispatched as a patch release to correct supporting-probe serialization classification behavior while preserving the same benchmark algorithm/dataset outcomes.

- Patch mode reuses the existing major directory (`reference/v<N>/`) and
  replaces all release assets in place (`reports/`, `logs/`,
  `supporting-probes/results/`, and `data/` under `reference/v<N>/`), then
  refreshes `reports/reference/v<N>/manifest.json` metadata (`tag`,
  `releasedAt`, `runId`, `lockfileHashes`).
- Patch mode must **not** be used for experiment-definition changes. If the
  experiment fingerprint should change, run a major release instead.

**github.com UI:**

1. Navigate to **Releases → Draft a new release**.
2. Under **Choose a tag**, type the new tag (e.g. `v1.0.0`) and pick
   **Create new tag: v1.0.0 on publish**.
3. **Target**: `main`.
4. **Title**: `v1.0.0` (or similar).
5. Leave description empty or summarize highlights.
6. Click **Publish release**.

### When the workflow fails

Common failure modes:

- **"Existence check"** — `reports/reference/v<N>/` already exists. The version
  was already released or partially committed. Investigate manually before
  retrying; do not delete reference data without admin consent.
- **"Fingerprint check"** — The experiment produces identical results to the
  previous release. Either there are no experiment-relevant changes since
  v<N-1> (release not needed), or a config change was missed.
- **"appId option is required" / mint fails** — the `app-id` secret referenced
  by `release.yml` is missing or empty on this repo. Add the secret (or switch
  the workflow back to secrets that already exist) before re-dispatching.
- **"Push to main failed"** — the App token mint failed, the App is not
  installed, or it lacks Always-allow bypass on `main-require-review`. The
  workflow log includes remediation steps.

For failures before the final push step, no repository state is changed on
`main`; re-run after fixing the cause. If the push step succeeds, the release
commit is already on `main` and re-running will stop at the existence check for
that version.

## Troubleshooting

**Guard fails with "Reference data is immutable"**: A file under one of the
four `reference/` trees was touched in the PR diff. Revert those changes and
push; the reference trees must only be updated by the release workflow.

**Guard fails with "release.yml without release-infra label"**: Add the
`release-infra` label to the PR from the Labels panel on the PR page, then
re-run the guard workflow.

**Supporting-probes post-run check fails**: A probe wrote output to a path
that resolves under `results/reference/`. Investigate the probe's output
directory logic and ensure it only writes to `results/local/`.
