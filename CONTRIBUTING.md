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

- The published results under the `reference/` directories are never edited. A major release
  publishes a new reference set instead ([Releases](./README.md#releases)).
- The experiment's inputs change only in a major release too: the code under [`src/`](./src/)
  (tests aside), the probes in [`supporting-probes/`](./supporting-probes/), the measurement
  runtime (the Node version and the CI runner) and the packages that run the experiment and the
  probes. A pull request that changes one is planned into the next major.
- A change that affects measurements needs an issue that agrees the method first.

## Contributing from a fork

1. For anything beyond a typo or small fix, open or comment on an issue.
2. Fork the repository and branch from `main`. Keep each pull request to one focused change.
3. Open the pull request against `main`. Its description starts with `Closes #N`, or
   `Relates to #N` if it only does part of the issue.
4. Leave "Allow edits from maintainers" checked.

CI on a first contribution runs after the maintainer approves it. Don't bump the version in
`package.json` or touch anything under a `reference/` directory.

## Checks

CI runs these on every pull request, on the Node version in [`.nvmrc`](./.nvmrc) and on Node 24.
Running them before you push is optional:

```bash
npm run lint              # ESLint + encoding check
npm run health:circular   # circular or unresolvable imports in src/ (dependency-cruiser)
npm test                  # unit tests (Node's built-in runner via tsx)
npm run lint:docs         # markdownlint, if you touched Markdown
```

CI also checks Markdown links, and runs the supporting-probe suite when `supporting-probes/`
changes. To run that suite yourself, see its
[prerequisites](./supporting-probes/README.md#prerequisites).
