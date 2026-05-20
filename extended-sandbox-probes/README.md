# Extended sandbox probes (supporting code)

These files are **supporting ecosystem probes** used to inform analysis. They are **not part of the main benchmark runner** and are not wired to repository npm scripts.

## Intended usage
- Run externally in your own sandbox environments.
- Keep fixtures minimal.
- Use these probes as references for consistent hydration verification logic.

## PASS / FAIL labels used by these probes
- **HYDRATION PASS**: all of the following hold after initial eager fetch/populate:
  1) no extra DB queries during deep traversal,
  2) runtime smart-check passes (identity stability + closure completeness),
  3) object graph is stable at end-of-run.
- **HYDRATION FAIL**: any hydration condition above fails.

Serialization is reported separately from hydration:
- `SERIALIZE_PASS`
- `SERIALIZE_FAIL_CYCLE` (failure attributable to circular reference)
- `SERIALIZE_FAIL_OTHER` (non-cycle serialization failure)

For analysis conclusions, use `analysis/*.md` reports (not this README).
