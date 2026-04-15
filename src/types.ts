/** Shape of a single entry in the data manifest (one per generated file). */
export interface ManifestEntry {
  filename: string;
  contentHash: string;
  /**
   * Declared root node ID for the dataset associated with this input file.
   * Only meaningful on `_input` manifest entries.
   *
   * When present, the benchmark preflight validator checks that:
   *   1. the declared root exists in the component list, and
   *   2. every node in the dataset is reachable from the root by following
   *      dependency edges.
   *
   * A declared `root` is required for datasets that are intended to satisfy
   * the core benchmark contract. Datasets that do not declare a root are
   * validated for structural integrity only (duplicate IDs, duplicate edges,
   * dangling references) for backward compatibility, but they do not qualify
   * as `core-valid`; treat them as `edge-case-only`.
   */
  root?: string;
}

/**
 * Top-level manifest written by generate.ts and read by runner.ts.
 * `files` uses `| undefined` values so callers must guard key lookups at runtime.
 */
export interface Manifest {
  generatedAt: string;
  files: Record<string, ManifestEntry | undefined>;
}
