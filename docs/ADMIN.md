# Admin Runbook — populate-all-demo

Personal operational notes for the project administrator. Not user-facing.

## Required status checks, label rules, and tag rules

This file documents the project-specific release guardrails, not the GitHub.com
ruleset configuration.

- `repo-config-guard.yml` should be a required status check on pull requests to
  `main` because it enforces the two release-safety rules that matter here:
  - PRs must not touch `reports/reference/`, `logs/reference/`, or
    `supporting-probes/results/reference/`
  - PRs that change `.github/workflows/release.yml` must carry the
    `release-infra` label
- `release-infra` is the only release-related label documented here. It is only
  for PRs that change the release workflow definition itself.
- Official releases do **not** use a separate label. They are identified by a
  major-only Git tag in the form `v<N>.0.0`.

## Reference data layout

The repo holds canonical experimental artifacts under three trees:

- `reports/reference/v<N>/` — the canonical benchmark outcomes for the tagged
  release across the experiment's dataset tiers
- `logs/reference/v<N>/` — the canonical trace evidence for how that release's
  experiment run behaved
- `supporting-probes/results/reference/v<N>/` — the canonical cross-framework
  supporting-probe results captured for that release

Where `<N>` is a major version (1, 2, 3, …). Until v1 is released, only the
`.gitkeep` files exist in each tree.

## The repo-config-guard workflow

`.github/workflows/repo-config-guard.yml` runs on every pull request against `main`
and enforces two rules:

1. **Reference-data immutability** — no PR may add, modify, delete, or rename
   anything under `reports/reference/`, `logs/reference/`, or
   `supporting-probes/results/reference/`. Only the release workflow (running on
   `workflow_dispatch` from `main`, never on `pull_request`) may write there.

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
git diff --no-renames --name-only --diff-filter=AMDR origin/main...HEAD | grep -E '^(reports|logs|supporting-probes/results)/reference/' || true
```

## Release procedure

The release workflow (`release.yml`, when added) should remain the **only**
automated process permitted to write to the `reference/` trees. It should run
on `workflow_dispatch` from `main` and never on `pull_request`.

Use this sequence when cutting an official release:

1. Update your local `main` checkout so the release starts from the current
   protected branch tip:

   ```bash
   git checkout main
   git pull --ff-only
   ```

2. Run the local smoke validation from this repo root before dispatching the
   release workflow:

   ```bash
   npm ci
   npm run lint
   npm run build
   npm test
   ```

   This confirms the same baseline behavior that the release artifacts are meant
   to preserve.

3. If the release workflow definition itself was changed in a preceding PR,
   merge that PR with the `release-infra` label first. That label is for changes
   to `release.yml`, not for the release run.

4. Dispatch the release workflow from the Actions tab on `main`, providing the
   next major version identifier (for example `v1`). That workflow is the only
   automation allowed to create the new `reference/` outputs.

5. After the workflow completes, inspect the new `reports/reference/v<N>/`,
   `logs/reference/v<N>/`, and `supporting-probes/results/reference/v<N>/`
   outputs on `main` to confirm they reflect the intended canonical experiment
   results for that release.

6. Create and push the release tag for the resulting commit:

   ```bash
   git tag v<N>.0.0
   git push origin v<N>.0.0
   ```

   The tag is the release marker. There is no separate release label.

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
  `supporting-probes/results/reference/v1/` on `main` from the public URL and
  confirm the JSON/log files are visible and readable.
- **Confirm `repo-config-guard.yml` still runs as a required check.** Open a
  trivial PR (e.g., a typo fix) after the visibility flip and confirm the
  guard appears in the required-checks list and passes.

## Troubleshooting

**Guard fails with "Reference data is immutable"**: A file under one of the
three `reference/` trees was touched in the PR diff. Revert those changes and
push; the reference trees must only be updated by the release workflow.

**Guard fails with "release.yml without release-infra label"**: Add the
`release-infra` label to the PR from the Labels panel on the PR page, then
re-run the guard workflow.

**Supporting-probes post-run check fails**: A probe wrote output to a path
that resolves under `results/reference/`. Investigate the probe's output
directory logic and ensure it only writes to `results/local/`.
