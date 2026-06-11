# Security Policy

This is a research repository that demonstrates cyclic graph hydration algorithms and surveys
ORM behavior across ecosystems. The code here is not intended for production use, but we still
welcome responsible disclosure of any security issue you discover.

## Reporting a Vulnerability

- **Preferred:** Use [GitHub's private vulnerability reporting](https://github.com/jml6m/populate-all-demo/security/advisories/new)
  (Security tab → Advisories → "Report a vulnerability").
- **Alternative:** Open a regular issue prefixed with `[SECURITY]` and minimal detail; we will
  move the conversation to a private advisory.

Please do **not** disclose publicly until we have had a reasonable opportunity to investigate.

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Out of Scope

- **Behavior of third-party ORMs** discussed in `analysis/ECOSYSTEM_RESEARCH.md`. Those belong to
  their respective maintainers; we surveyed them, we don't own them.
- **Vulnerabilities in dependencies** — please report upstream. Dependabot tracks them here.
- **Performance characteristics** of the surveyed ORMs at scales beyond what `reference/v1/`
  documents.
