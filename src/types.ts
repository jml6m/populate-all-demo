/** Shape of a single entry in the data manifest (one per generated file). */
export interface ManifestEntry {
  filename: string;
  contentHash: string;
}

/**
 * Top-level manifest written by generate.ts and read by runner.ts.
 * `files` uses `| undefined` values so callers must guard key lookups at runtime.
 */
export interface Manifest {
  generatedAt: string;
  files: Record<string, ManifestEntry | undefined>;
}
