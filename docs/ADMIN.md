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
- `release-infra` is the only release-related label documented here. It is only
  for PRs that change the release workflow definition itself.
- Official releases do **not** use a separate label. They are identified by a
  SemVer tag (`v<N>.0.0` for majors, `v<N>.0.<P>` for patch hotfixes).

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
   - `patch`: overwrites `supporting-probes/results/reference/v<N>/` only
7. Writes/updates `reports/reference/v<N>/manifest.json` (tag, releasedAt, runId, lockfile hashes).
8. Bumps `package.json` to the computed SemVer via `npm version`.
9. Commits and pushes directly to `main` using the `RELEASE_PUSH_TOKEN` PAT.

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
3. Watch the run log. Successful completion ends with `✅ Pushed release v<N>.0.0 to main`.

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

Use `release_type=patch` only when fixing interpretation-critical defects
without changing the experiment fingerprint (for example: supporting-probe
classification bugs or release-manifest/doc errors tied to published outputs).

- Patch mode reuses the existing major directory (`reference/v<N>/`), updates
  `supporting-probes/results/reference/v<N>/`, and refreshes
  `reports/reference/v<N>/manifest.json` metadata (`tag`, `releasedAt`, `runId`,
  `lockfileHashes`).
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
- **"Push to main failed"** — `RELEASE_PUSH_TOKEN` is missing, expired, or
  lacks the right scopes. The error message in the workflow log includes
  remediation steps.

For failures before the final push step, no repository state is changed on
`main`; re-run after fixing the cause. If the push step succeeds, the release
commit is already on `main` and re-running will stop at the existence check for
that version.

## Post-v1 admin actions (one-time)

These actions apply only to the v1 release — not to v2, v3, etc. Once completed,
this section can be deleted or moved to a historical-record archive at the
admin's discretion.

- **Flip repository visibility to public.** Settings → General → Danger Zone →
  Change visibility → Public. Confirm by typing the repo name. After flipping,
  verify the GitHub-hosted README, ADMIN, and analysis docs render correctly
  for an anonymous viewer (open in an incognito window).
- **Verify reference artifacts are intact post-flip.** Visit
  `reports/reference/v1/`, `logs/reference/v1/`, and
  `supporting-probes/results/reference/v1/`, and `data/reference/v1/` on
  `main` from the public URL and confirm the JSON/log files are visible and
  readable.
- **Confirm `repo-config-guard.yml` still runs as a required check.** Open a
  trivial PR (e.g., a typo fix) after the visibility flip and confirm the
  guard appears in the required-checks list and passes.

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
