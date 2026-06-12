# Issue Workflow

Work in this repo is tracked on GitHub. Use open issues as the planning source of truth.

## Before non-trivial work

- Scan open issues for related or duplicate effort.
- If your work addresses an issue, reference it in the PR or summary (e.g. `fixes #17`).
- If deferring follow-up work, link an existing issue instead of leaving an untracked TODO.

## While working

- Keep changes scoped to the requested task. Avoid drive-by refactors of the runner, generator, or unrelated probes.
- Respect the protected paths in `AGENTS.md`: never modify `reference/` artifacts, never bump the `package.json` version, never touch `release.yml` without the `release-infra` label.
- Do not invent version bumps or publish steps. Releases are an admin-only manual flow through `release.yml`; this package is not published to npm.

## When blocked

- After three failed attempts at the same error, stop retrying the same approach (AGENTS.md §1).
- Revert to the last known good state, document what was tried, and use `// FIXME: <reason>; tracked in issue #<id>` only when a temporary marker is truly needed.
- Prefer reporting the blocker with environment facts over guessing.
