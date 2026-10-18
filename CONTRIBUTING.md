# Contributing to populate-all-demo

populate-all-demo is a research repository maintained by one person. Issues and pull requests are
welcome; response times are best-effort.

## What's wanted

- Bug reports with a reproduction: the command, dataset tier, platform, and what you expected.
- Corrections to the supporting probes or the analysis, with evidence.
- Fixes to the runner, generator and tooling that keep results unchanged.

## Research contributions

Results stay comparable only if the conditions they were measured under stay fixed:

- The published results under the `reference/` directories change only in a major release, which
  publishes a new reference set. They are never edited.
- The measured libraries in [`supporting-probes/`](./supporting-probes/) are pinned, and the
  measurement runtime (the Node version in [`.nvmrc`](./.nvmrc) and the CI runner) is fixed per
  release. Changing either is planned into the next major.
- A change that affects measurements needs an issue that agrees the method first.
- Gates and report-only output are different things. A gate fails the run (the empirical runtime
  check in the tests is one); report-only output is printed or written to a report and never
  fails anything. Say which one a new check is.

## Contributing from a fork

1. For anything beyond a typo or small fix, open or comment on an issue first and agree the
   approach there, using the templates under [`.github/ISSUE_TEMPLATE/`](./.github/ISSUE_TEMPLATE/).
   Follow the design an issue describes; to propose a different one, say so on the issue before
   writing code.
2. Fork the repository and branch from `main`. Keep each pull request to one focused change.
3. Run the [local checks](#local-checks) before you push.
4. Open the pull request against `main`. Its description starts with `Closes #N`, or
   `Relates to #N` if it only does part of the issue. That issue must be open and in a
   milestone; the maintainer adds milestones, so ask on the issue if it has none. The
   `issue-link` check enforces this.
5. Leave "Allow edits from maintainers" checked.

CI on a first contribution runs after the maintainer approves it. Pull requests are reviewed as the
maintainer has time, with no fixed response time, and are squash-merged. Don't open a pull request
you don't plan to see through.

Don't bump the version in `package.json` or touch anything under a `reference/` directory.

## Local checks

```bash
npm ci
npm run lint              # ESLint + encoding check
npm run health:circular   # circular imports in src/ (madge)
npm test                  # unit tests (Node's built-in runner via tsx)
npm run lint:docs         # markdownlint, if you touched Markdown
```

CI runs the same on Node 22.22.3 and 24.18.0, plus a link check on Markdown, and the supporting-probe
suite when `supporting-probes/` changes. Use the Node version in [`.nvmrc`](./.nvmrc).

The supporting-probe suite (`cd supporting-probes && npm ci && npm run probe:all`) also needs Python,
Ruby, Java with Maven, .NET 8 and a running MongoDB (set `MONGODB_URI` if it isn't on
`127.0.0.1:27017`); [`supporting-probes.yml`](./.github/workflows/supporting-probes.yml) has the
versions and install steps. Without them, run it on your fork: enable Actions there and start the
Supporting Probes workflow on your branch.

## Where the rules live

[AGENTS.md](./AGENTS.md) has the commands, the determinism rules and the coding standards.
Security reports go through [SECURITY.md](./SECURITY.md).
