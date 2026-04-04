/**
 * Attempts to serialize an arbitrary value with JSON.stringify.
 *
 * Returns `{ pass: true }` when serialization succeeds.
 * Returns `{ pass: false, errorDetail: <message> }` when JSON.stringify throws
 * (e.g. "Converting circular structure to JSON" for cyclic object graphs).
 *
 * This check is intentionally separate from hydration correctness.  An
 * algorithm that correctly produces a cyclic in-memory graph will always fail
 * this check — that is expected and informative, not a correctness failure.
 * See EXPERIMENT_ANALYSIS.md §4 and ECOSYSTEM_RESEARCH.md for context.
 */
export function serializeCheck(value: unknown): { pass: boolean; errorDetail: string | null } {
  try {
    JSON.stringify(value);
    return { pass: true, errorDetail: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { pass: false, errorDetail: msg !== '' ? msg : 'JSON.stringify threw an unknown error' };
  }
}
