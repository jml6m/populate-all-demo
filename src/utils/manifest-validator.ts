import { ComponentFlat } from '../algorithms/types';

/**
 * Three-tier classification for benchmark dataset inputs.
 *
 * - core-valid    — passes all structural integrity checks and satisfies the
 *                   full core benchmark contract: no duplicate node IDs, no
 *                   duplicate edges, no dangling references, and (when a root
 *                   is declared) the declared root exists and every node is
 *                   reachable from it by following dependency edges.
 *
 * - edge-case-only — structurally sound (no hard errors) but does not meet
 *                   the full core benchmark contract — e.g. disconnected
 *                   subgraphs, multi-root forest, or a declared root that
 *                   cannot reach every node.  Useful for robustness and
 *                   edge-case test suites; should not be used in canonical
 *                   benchmark measurements.
 *
 * - invalid       — contains one or more hard structural errors (dangling
 *                   references, duplicate node IDs, duplicate edges, or a
 *                   declared root that does not exist in the dataset).  Must
 *                   be rejected before any algorithm execution.
 *
 * This taxonomy aligns with the motivating model and taxonomy defined in
 * analysis/ECOSYSTEM_RESEARCH.md §6.
 */
export type ValidationClassification = 'core-valid' | 'edge-case-only' | 'invalid';

export interface ValidationResult {
  classification: ValidationClassification;
  /** Hard structural errors.  Non-empty iff classification === 'invalid'. */
  errors: string[];
  /**
   * Soft notices about graph properties (e.g. unreachable nodes).
   * Non-empty iff classification === 'edge-case-only'.
   */
  warnings: string[];
}

export interface ValidatorOptions {
  /**
   * Declared root node ID for the dataset.
   *
   * When provided, the validator additionally checks that:
   *   1. the root exists in the component list (hard error if missing), and
   *   2. every node is reachable from the root by following dependency edges
   *      (soft warning — produces edge-case-only classification if any node
   *      is unreachable).
   *
   * When absent, the root-reachability check is skipped and the classification
   * is determined solely by structural integrity checks.
   */
  root?: string;
}

/**
 * Validates a parsed input dataset for benchmark preflight / input admissibility.
 *
 * This function MUST NOT be called inside a timed benchmark section.  It is a
 * fixture-preparation guard only — equivalent to the setup / warm-up phase in
 * JMH (Java), criterion (Rust), or benchmark.js setup closures.  Measured
 * algorithm complexity, latency, and memory are unaffected.
 *
 * Checks performed (in order):
 *   1. Duplicate node IDs                              → invalid
 *   2. Dangling references (edge target not in node set) → invalid
 *   3. Duplicate edges (u → v listed more than once)   → invalid
 *   4. (if root declared) Root existence               → invalid if missing
 *   5. (if root declared) Root-reachability of every node
 *                                                      → edge-case-only if any unreachable
 *
 * @param components - Parsed flat component list (ComponentFlat[]).
 * @param options    - Optional validation options (declared root, etc.).
 */
export function validateDataset(components: ComponentFlat[], options: ValidatorOptions = {}): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- Step 1: Build the node-ID set; detect duplicate IDs. ---
  const nodeIds = new Set<string>();
  for (const comp of components) {
    if (nodeIds.has(comp.id)) {
      errors.push(`Duplicate node ID: "${comp.id}"`);
    } else {
      nodeIds.add(comp.id);
    }
  }

  if (errors.length > 0) {
    // Cannot safely validate edges without a clean node set.
    return { classification: 'invalid', errors, warnings };
  }

  // --- Steps 2 & 3: Scan edges for dangling references and duplicate edges. ---
  for (const comp of components) {
    const seenDeps = new Set<string>();
    for (const dep of comp.dependencies) {
      if (!nodeIds.has(dep)) {
        errors.push(`Dangling reference: node "${comp.id}" depends on unknown node "${dep}"`);
      }
      if (seenDeps.has(dep)) {
        errors.push(`Duplicate edge: node "${comp.id}" lists dependency "${dep}" more than once`);
      } else {
        seenDeps.add(dep);
      }
    }
  }

  if (errors.length > 0) {
    return { classification: 'invalid', errors, warnings };
  }

  // --- Steps 4 & 5: Root-based checks (only when a root is declared). ---
  if (options.root !== undefined) {
    if (!nodeIds.has(options.root)) {
      errors.push(`Declared root "${options.root}" does not exist in the dataset`);
      return { classification: 'invalid', errors, warnings };
    }

    const reachable = computeReachableSet(components, options.root);
    const unreachableIds = [...nodeIds].filter((id) => !reachable.has(id));
    if (unreachableIds.length > 0) {
      const sample = unreachableIds.slice(0, 5).join(', ');
      const suffix = unreachableIds.length > 5 ? ` (and ${unreachableIds.length - 5} more)` : '';
      warnings.push(
        `${unreachableIds.length} node(s) not reachable from declared root "${options.root}": ${sample}${suffix}`
      );
    }
  }

  if (warnings.length > 0) {
    return { classification: 'edge-case-only', errors, warnings };
  }

  return { classification: 'core-valid', errors, warnings };
}

/**
 * Computes the set of node IDs reachable from `root` by following dependency
 * edges (BFS over the outgoing adjacency list).
 *
 * Assumes the component list has already been validated for duplicate IDs and
 * dangling references; unknown dependency IDs are silently skipped.
 */
function computeReachableSet(components: ComponentFlat[], root: string): Set<string> {
  const adj = new Map<string, readonly string[]>();
  for (const comp of components) {
    adj.set(comp.id, comp.dependencies);
  }

  const reachable = new Set<string>([root]);
  const queue: string[] = [root];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head++];
    for (const dep of adj.get(current) ?? []) {
      if (!reachable.has(dep)) {
        reachable.add(dep);
        queue.push(dep);
      }
    }
  }

  return reachable;
}
