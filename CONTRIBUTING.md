# Contributing to populate-all-demo

populate-all-demo is a research repository maintained by one person. Issues and pull requests are
welcome; response times are best-effort.

Templates can be found in [`.github/ISSUE_TEMPLATE/`](./.github/ISSUE_TEMPLATE/).

## What's wanted

- Bug reports using the provided template.
- Corrections to the supporting probes or the analysis, with evidence.
- Optimizations for the runner, generator and tooling.

## Research contributions

Results stay comparable only if the conditions they were measured under stay fixed:

- The published results under the `reference/` directories change only in a major release, which
  publishes a new reference set. They are never edited.
- The experiment's inputs change only in a major release too: the code under [`src/`](./src/)
  (tests aside), the probes in [`supporting-probes/`](./supporting-probes/), the measurement
  runtime (the CI runner) and
  the packages that run the experiment and the probes. A pull request that changes one goes into
  the next major's milestone.
- A change that affects measurements needs an issue that agrees the method first.

## Contributing from a fork

1. For anything beyond a typo or small fix, open or comment on an issue.
2. Fork the repository and branch from `main`. Keep each pull request to one focused change.
3. Run the [local checks](#local-checks) before you push.
4. Open the pull request against `main`. Its description starts with `Closes #N`, or
   `Relates to #N` if it only does part of the issue.
5. Leave "Allow edits from maintainers" checked.

CI on a first contribution runs after the maintainer approves it. Don't bump the version in `package.json` or touch anything under a `reference/` directory.

## Dependencies

```bash
npm ci
npm run lint              # ESLint + encoding check
npm run health:circular   # circular imports in src/ (madge)
npm test                  # unit tests (Node's built-in runner via tsx)
npm run lint:docs         # markdownlint, if you touched Markdown
```

Use the Node version in [`.nvmrc`](./.nvmrc).

The supporting-probe suite (`cd supporting-probes && npm ci && npm run probe:all`) requires additional dependencies; [`supporting-probes.yml`](./.github/workflows/supporting-probes.yml) has the
versions and install steps. Without them, run it on your fork: enable Actions there and start the Supporting Probes workflow on your branch.
