# Contributing to populate-all-demo

populate-all-demo is a research repository maintained by one person. Issues and pull requests are
welcome; response times are best-effort.

## What's wanted

- Bug reports with a reproduction: the command, dataset tier, platform, and what you expected.
- Corrections to the supporting probes or the analysis, with evidence.
- Fixes to the runner, generator and tooling that keep results unchanged.

Changes that alter the experiment or its results are planned into the next major version, which
publishes a new reference set. The published `reference/` directories are never edited.

## Before you open a PR

Open an issue first for anything beyond a typo, so the approach is agreed before code is written.
Use the templates under [`.github/ISSUE_TEMPLATE/`](./.github/ISSUE_TEMPLATE/).

## Local gates

```bash
npm ci
npm run lint        # ESLint + encoding check
npm test            # unit tests (Node's built-in runner via tsx)
npm run lint:docs   # markdownlint, if you touched Markdown
```

CI runs the same, plus the supporting-probe suite and a link check on Markdown. Use the Node version
in [`.nvmrc`](./.nvmrc).

## PR conventions

- Open the PR against `main`. Its description has a line starting with `Relates to #N` for the
  issue it serves; the `issue-link` check requires it.
- Keep a PR to one change. PRs are squash-merged.
- Don't bump the version in `package.json` or touch anything under a `reference/` directory.

## Where the rules live

[AGENTS.md](./AGENTS.md) has the commands, the determinism rules and the coding standards.
Security reports go through [SECURITY.md](./SECURITY.md).
