---
name: Bug report
about: Report a defect in the experiment runner, supporting probes, or release infrastructure
title: '[BUG] '
labels: bug
assignees: ''
---

**Overview** A clear and concise description of the failure.

**Environment**
- **Repo SHA / branch:** (e.g., `main` HEAD `abc1234`, or release tag `v1.0.0`)
- **Node version:** (e.g., v22.17.1)
- **OS:** (e.g., GitHub Actions Ubuntu / macOS local / Windows local / WSL)
- **Polyglot toolchain (if probe-related):** Python <version>, Ruby <version>, Java <version>, .NET <version>

**Reproduction Steps**
1.
2.
3.

**Expected Behavior**

**Actual Behavior**

**Affected Component**
- [ ] Experiment runner (`src/`)
- [ ] Generator (`src/generate.ts`, `src/generate-config.json`)
- [ ] Supporting probe (specify): typeorm / sequelize / mikroorm / prisma / mongoose / sqlalchemy / activerecord / hibernate / efcore
- [ ] Release workflow (`.github/workflows/release.yml`)
- [ ] Other CI workflow (specify path)
- [ ] Documentation (specify file)

**Test Context (if applicable)**
- **Failing test/probe:** (e.g., `src/runner.test.ts`, `mongoose-test.ts`)
- **Command run:** (e.g., `npm test`, `npm run probe:all`)
- **Error output:**

```
paste here
```

**Reference data impact**
- [ ] Bug affects committed reference data (v1 or later)
- [ ] Bug affects only local runs / does not change committed data
- [ ] Unsure

**Severity**
- [ ] Critical — invalidates published research findings
- [ ] High — affects experiment correctness or workflow reliability
- [ ] Medium — minor incorrect output or doc inaccuracy
- [ ] Low — cosmetic, edge case
