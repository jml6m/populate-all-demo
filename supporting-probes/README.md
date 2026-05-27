# Supporting probes

These are supporting sandbox scripts used to validate analysis tables/matrices.
They are intentionally simple and separate from the main experiment runner.

Each probe reports:
- hydration result (`HYDRATION PASS` / `HYDRATION FAIL`)
- query gate result (extra DB hits during traversal)
- runtime `smartCheck` result (identity + closure)
- serialization result (`SERIALIZE_PASS`, `SERIALIZE_FAIL_CYCLE`, `SERIALIZE_FAIL_OTHER`)
