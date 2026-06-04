import type { ComponentFlat } from '../algorithms/types';

/**
 * Three-tier classification for benchmark dataset inputs.
 *
 * - core-valid     — passes all structural integrity checks and satisfies the
 *                    full core benchmark contract: a unique root node exists
 *                    (exactly one node with no incoming edges), every other
 *                    node is reachable from it by following dependency edges,
 *                    and there are no duplicate node IDs, duplicate edges, or
 *                    dangling references.
 *
 * - edge-case-only — structurally sound (no hard errors) but does not meet
 *                    the full core benchmark contract — e.g. no uniquely
 *                    detectable root (all nodes are in cycles, or multiple
 *                    nodes have zero incoming edges), or the auto-detected
 *                    root cannot reach every node.  Useful for robustness and
 *                    edge-case test suites; must not be used in canonical
 *                    benchmark measurements.
 *
 * - invalid        — contains one or more hard structural errors (dangling
 *                    references, duplicate node IDs, or duplicate edges).
 *                    Must be rejected before any algorithm execution.
 *
 * The root is **always inferred from the graph structure** — the unique node
 * whose in-degree (number of incoming edges from other nodes) is zero.
 * No external root declaration is required or accepted.
 *
 * This taxonomy aligns with the motivating model and taxonomy defined in
 * analysis/ECOSYSTEM_RESEARCH.md §6.
 */
export type ValidationClassification = 'core-valid' | 'edge-case-only' | 'invalid';

/**
 * Discriminated-union result type produced by {@link validateDataset}.
 *
 * The `classification` field acts as the discriminant:
 *
 * - `'core-valid'`    → `errors` is always `[]`, `warnings` is always `[]`.
 *                       TypeScript enforces this at compile time.
 * - `'edge-case-only'` → `errors` is always `[]`; `warnings` is non-empty
 *                       and describes why the dataset is not core-valid.
 * - `'invalid'`       → `errors` is non-empty and lists each hard error;
 *                       `warnings` is always `[]`.
 *
 * Consumers can narrow the type with a simple `classification` check:
 * ```ts
 * if (result.classification === 'invalid') {
 *   for (const e of result.errors) { ... }  // errors: string[]
 * }
 * ```
 */
export type ValidationResult =
  | { classification: 'core-valid'; errors: []; warnings: [] }
  | { classification: 'edge-case-only'; errors: []; warnings: string[] }
  | { classification: 'invalid'; errors: string[]; warnings: [] };

/**
 * Validates a parsed input dataset for benchmark preflight / input admissibility.
 *
 * This function MUST NOT be called inside a timed benchmark section.  It is a
 * fixture-preparation guard only — equivalent to the setup / warm-up phase in
 * JMH (Java), criterion (Rust), or benchmark.js setup closures.  Measured
 * algorithm complexity, latency, and memory are unaffected.
 *
 * Checks performed (in order):
 *
 *   Pass 1 — node collection:
 *     1. Duplicate node IDs                              → invalid (early exit)
 *        In-degree counters are also initialised here.
 *
 *   Pass 2 — edge validation + in-degree computation:
 *     2. Dangling references (edge target not in node set) → invalid
 *     3. Duplicate edges (u → v listed more than once)    → invalid
 *        Valid (non-dangling) edges increment the in-degree counter of their
 *        target.  This must be a separate pass because the full node-ID set is
 *        required to distinguish dangling references from valid edges, and that
 *        set is only complete after pass 1.
 *
 *   Root detection (from in-degree data collected in pass 2):
 *     4. Count nodes with in-degree zero (zero-in-degree candidates).
 *        • Exactly 1 → auto-detected root; proceed to reachability check.
 *        • 0 (all in cycles) → edge-case-only
 *        • > 1 (multi-root) → edge-case-only
 *
 *   Reachability check (BFS from auto-detected root):
 *     5. Every node must be reachable from the root     → edge-case-only if any are not
 *
 * @param components - Parsed flat component list (ComponentFlat[]).
 */
export function validateDataset(components: ComponentFlat[]): ValidationResult {
  // ---------------------------------------------------------------------------
  // Pass 1: Build the node-ID set and initialise per-node in-degree counters.
  //         Detect duplicate IDs immediately.
  // ---------------------------------------------------------------------------
  const nodeIds = new Set<string>();
  const inDegree = new Map<string, number>();
  const duplicateErrors: string[] = [];

  for (const comp of components) {
    if (nodeIds.has(comp.id)) {
      duplicateErrors.push(`Duplicate node ID: "${comp.id}"`);
    } else {
      nodeIds.add(comp.id);
      inDegree.set(comp.id, 0); // initialise in-degree; pass 2 will increment it
    }
  }

  if (duplicateErrors.length > 0) {
    // Cannot safely validate edges without a clean, deduplicated node set.
    return { classification: 'invalid', errors: duplicateErrors, warnings: [] };
  }

  // ---------------------------------------------------------------------------
  // Pass 2: Scan every edge for dangling references and duplicates; count
  //         in-degrees for valid edges.  A separate pass is necessary because
  //         dangling-reference detection requires the complete node-ID set,
  //         which is only fully available after pass 1 finishes.
  // ---------------------------------------------------------------------------
  const edgeErrors: string[] = [];

  for (const comp of components) {
    const seenDeps = new Set<string>();
    for (const dep of comp.dependencies) {
      if (!nodeIds.has(dep)) {
        edgeErrors.push(`Dangling reference: node "${comp.id}" depends on unknown node "${dep}"`);
      } else {
        // Only increment in-degree for valid (non-dangling) edges so that
        // dangling references do not corrupt root detection.
        inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1);
      }
      if (seenDeps.has(dep)) {
        edgeErrors.push(`Duplicate edge: node "${comp.id}" lists dependency "${dep}" more than once`);
      } else {
        seenDeps.add(dep);
      }
    }
  }

  if (edgeErrors.length > 0) {
    return { classification: 'invalid', errors: edgeErrors, warnings: [] };
  }

  // ---------------------------------------------------------------------------
  // Root detection: the root must be the unique node whose in-degree is zero
  // (i.e. no other node lists it as a dependency).  This is inferred entirely
  // from the graph structure — no external declaration is needed or accepted.
  // ---------------------------------------------------------------------------
  const zeroInDegreeNodes = [...inDegree.entries()].filter(([, deg]) => deg === 0).map(([id]) => id);

  if (zeroInDegreeNodes.length !== 1) {
    let warning: string;
    if (zeroInDegreeNodes.length === 0) {
      warning =
        nodeIds.size === 0
          ? 'No root detected: the dataset contains no nodes'
          : 'No root detected: every node has at least one incoming edge (the graph is fully cyclic with no unique entry point)';
    } else {
      const sample = zeroInDegreeNodes.slice(0, 5).join(', ');
      const suffix = zeroInDegreeNodes.length > 5 ? ` (and ${zeroInDegreeNodes.length - 5} more)` : '';
      warning = `${zeroInDegreeNodes.length} candidate root(s) detected — a single root is required for core benchmark classification: ${sample}${suffix}`;
    }
    return { classification: 'edge-case-only', errors: [], warnings: [warning] };
  }

  const root = zeroInDegreeNodes[0]!;

  // ---------------------------------------------------------------------------
  // Reachability check: every node must be reachable from the auto-detected
  // root by following outgoing dependency edges.
  // ---------------------------------------------------------------------------
  const reachable = computeReachableSet(components, root);
  const unreachableIds = [...nodeIds].filter((id) => !reachable.has(id));

  if (unreachableIds.length > 0) {
    const sample = unreachableIds.slice(0, 5).join(', ');
    const suffix = unreachableIds.length > 5 ? ` (and ${unreachableIds.length - 5} more)` : '';
    return {
      classification: 'edge-case-only',
      errors: [],
      warnings: [`${unreachableIds.length} node(s) not reachable from auto-detected root "${root}": ${sample}${suffix}`],
    };
  }

  return { classification: 'core-valid', errors: [], warnings: [] };
}

/**
 * Computes the set of node IDs reachable from `root` by following dependency
 * edges (index-based BFS over the outgoing adjacency list — O(n), not O(n²)).
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
    const current = queue[head++]!;
    for (const dep of adj.get(current) ?? []) {
      if (!reachable.has(dep)) {
        reachable.add(dep);
        queue.push(dep);
      }
    }
  }

  return reachable;
}
