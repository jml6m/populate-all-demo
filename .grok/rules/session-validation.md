# Session Validation (Mandatory)

Before ending any implementation task in this repo, run validation and report results explicitly. Do not claim success without executing these checks.

## Required closeout checklist

Run in order. Stop and fix failures before handing work back.

| Step | Command | When required |
|------|---------|---------------|
| 1. Encoding | `npm run lint:encoding` | **Always** — no BOM / CRLF / non-UTF-8 / control chars. |
| 2. Lint | `npm run lint` | **Always** — ESLint clean (also runs the encoding gate). |
| 3. Audit | `npm run audit:ci` | **Always** — zero critical/high in production deps (dev-only advisories reported, not gated). |
| 4. Tests | `npm test` | **Always** — `tsx --test` suite passes. |
| 5. Determinism | Re-run the touched generation/experiment path | When runner/generator/algorithm code changed — same seed must yield identical output (AGENTS.md §7). |

`npm run lint` runs ESLint + the encoding gate (steps 1–2). Step 3 (`npm run audit:ci`) is a separate command — it is also run by `npm run npm:reinstall` and enforced in CI.

## Reporting policy

In the final response, include a short **Validation** section listing each command and pass/fail, e.g.:

```
Validation: lint:encoding ✓ | lint ✓ | audit:ci ✓ | test ✓
```

If a step was skipped, say why and call out residual risk.

## Commit / push protocol

Per `AGENTS.md`, agents do not push or create commits unless the environment explicitly supports agent-authored commits and you were instructed to. When you are cleared to sync: stage your files by explicit path, commit with a descriptive message, and push to a feature branch — never directly to `main`, and never with a version bump or tag.
