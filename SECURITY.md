# Security Policy

This is a research repository that demonstrates cyclic graph hydration algorithms and surveys
ORM behavior across ecosystems. The code here is not intended for production use, but we still
welcome responsible disclosure of any security issue you discover.

## Reporting a Vulnerability

- **Preferred:** Use [GitHub's private vulnerability reporting](https://github.com/jml6m/populate-all-demo/security/advisories/new)
  (Security tab → Advisories → "Report a vulnerability").
- **Alternative:** If you cannot use the advisory form, contact the maintainer via https://github.com/jml6m and we will open a private advisory on your behalf.

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
- **Performance characteristics** of the surveyed ORMs at scales beyond what the v1 reference artifacts document (for example: `reports/reference/v1/`, `logs/reference/v1/`, `supporting-probes/results/reference/v1/`, and `data/reference/v1/`).
