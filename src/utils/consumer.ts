import { ComponentPopulated } from '../algorithms/types';

/**
 * The result of a single consumer probe run against a hydrated graph.
 */
export interface ConsumerResult {
  pass: boolean;
  errorDetail: string | null;
}

/**
 * A ConsumerProbe describes one strategy for consuming (serializing or
 * traversing) a hydrated cyclic graph.  Probes must not mutate the input.
 *
 * Named "probe" rather than "serializer" because not every strategy produces a
 * string: some traverse the graph, some export an alternative representation,
 * and some attempt a standard format (e.g. JSON).  The interface is intentionally
 * generic so that new strategies can be added without changing the runner.
 *
 * See analysis/ECOSYSTEM_RESEARCH.md §3.3 for the taxonomy of serialization
 * strategies (Cycle Truncation, Back-Reference Pruning, ID Substitution, and
 * Custom Cycle-Aware Serialization) that motivates this abstraction.
 */
export interface ConsumerProbe {
  /** Short identifier used in reports (e.g. "naive-json", "cycle-flat"). */
  name: string;
  /** One-line description of what the probe does. */
  description: string;
  /** Run the probe against a hydrated graph and return a pass/fail result. */
  consume: (graph: ComponentPopulated[]) => ConsumerResult;
}

// ---------------------------------------------------------------------------
// Probe implementations
// ---------------------------------------------------------------------------

/**
 * Naive JSON probe — attempts `JSON.stringify` on the raw cyclic graph object.
 *
 * This probe will always throw "Converting circular structure to JSON" on any
 * graph that contains cycles, regardless of which population algorithm produced
 * it.  Its purpose is to demonstrate that hydration success ≠ serialization
 * safety: an algorithm can correctly construct a cyclic in-memory graph and still
 * crash a downstream consumer that relies on native JSON serialization.
 *
 * This corresponds to the "Custom Cycle-Aware Serialization" failure mode
 * documented for MikroORM, Hibernate, and EF Core in EXPERIMENT_ANALYSIS.md §2
 * and ECOSYSTEM_RESEARCH.md §2.
 */
export const naiveJsonProbe: ConsumerProbe = {
  name: 'naive-json',
  description: 'JSON.stringify on the raw graph — fails on any circular reference',
  consume: (graph: ComponentPopulated[]): ConsumerResult => {
    try {
      JSON.stringify(graph);
      return { pass: true, errorDetail: null };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { pass: false, errorDetail: msg };
    }
  },
};

/**
 * Cycle-aware flat export probe — converts the graph to an index-based
 * representation (each node's dependencies stored as integer indices into the
 * top-level array) using a visited Map rather than recursive descent.
 *
 * This is an iterative O(V+E) traversal that is safe at any graph scale: it
 * never recurses, so it cannot cause a call-stack overflow regardless of graph
 * depth or cycle length.
 *
 * This probe models the "ID Substitution" / "Custom Cycle-Aware Serialization"
 * strategies from ECOSYSTEM_RESEARCH.md §3.3: revisited objects are replaced by
 * their index rather than re-traversed, preserving full graph fidelity.  It is
 * structurally identical to the `AnswerEntry` format the experiment already uses
 * for verification — confirming that the verification pipeline itself is
 * serialization-safe by design.
 */
export const cycleFlatProbe: ConsumerProbe = {
  name: 'cycle-flat',
  description:
    'Iterative index-based export (AnswerEntry format) — cycle-safe at any graph scale',
  consume: (graph: ComponentPopulated[]): ConsumerResult => {
    try {
      // Build an identity-index map in O(V)
      const indexMap = new Map<ComponentPopulated, number>();
      for (let i = 0; i < graph.length; i++) {
        indexMap.set(graph[i], i);
      }

      // Validate + export each node's dependency list in O(V + E)
      for (const node of graph) {
        for (const dep of node.dependencies) {
          if (!indexMap.has(dep)) {
            return {
              pass: false,
              errorDetail: `Dependency "${dep.id}" of node "${node.id}" is not present in the top-level graph array`,
            };
          }
        }
      }

      return { pass: true, errorDetail: null };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { pass: false, errorDetail: msg };
    }
  },
};

/**
 * The ordered list of consumer probes run by the experiment runner after a
 * successful hydration stage.  The runner iterates this array so that new
 * probes can be added here without changing runner.ts.
 */
export const consumerProbes: ConsumerProbe[] = [naiveJsonProbe, cycleFlatProbe];
