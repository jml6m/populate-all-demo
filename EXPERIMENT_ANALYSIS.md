# Experiment Analysis: `populate-all-demo`

## Overview

The `populateAll()` problem is straightforward on acyclic graphs: recursively replace each
foreign-key ID with the fully-resolved node it references. The challenge arises when the graph
contains cycles — mutual or self-referential dependencies that are common in real component
systems, org charts, and permission models. On these graphs, naive recursion does not terminate.

This experiment benchmarks four algorithms across three dataset tiers (basic: 10 nodes,
medium: 5 000 nodes, stress: 50 000 nodes) to measure which strategies are correct, which are
safe at scale, and how their time and memory characteristics differ. All datasets are
deterministically seeded cyclic graphs.

> **Context:** The motivating real-world instance that prompted this experiment was observing
> similar failure behavior in ODM `populate()` calls on self-referential schemas (e.g.
> [Mongoose issue #16074](https://github.com/Automattic/mongoose/issues/16074)), but the
> problem is a general graph algorithm challenge that is not specific to any framework or
> database driver.

---

## Results (representative run)

| Algorithm | Category | basic (10 nodes) | medium (5 000 nodes) | stress (50 000 nodes) |
|---|---|---|---|---|
| **Naive Recursion** | Reference Tracking | ❌ Stack overflow | ❌ Stack overflow | ❌ Stack overflow |
| **Map Tracker** | Reference Tracking | ✅ 0.3 ms / < 0.1 MB | ✅ 11 ms / 3.3 MB | ❌ Stack overflow |
| **Tarjan SCC Layering** | Topological | ✅ 0.6 ms / < 0.1 MB | ✅ 28 ms / 9.2 MB | ✅ 362 ms / 37 MB |
| **Two-Pass Wire** | Schema-Driven | ✅ 0.2 ms / < 0.1 MB | ✅ 7.4 ms / 3.0 MB | ✅ 81 ms / < 0.1 MB |

> Times are wall-clock; RAM is heap-delta (before → after `execute()`). Absolute values vary
> by machine — relative comparisons are what matter.

---

## Findings

### Finding 1 — Naive Recursion (O(∞)) Fails on Every Cyclic Tier

The `naiveRecursion` algorithm is the control: it is the unguarded recursive pattern. It fails
at every tier — including the trivial 10-node basic dataset — because the seeded graph
generator deliberately produces cycles. The call stack overflows the moment the traversal
revisits a node, which happens immediately in any dense cyclic graph.

This is not a contrived edge case. Any real-world graph that allows bidirectional references
will exhibit this failure. Naive recursion is not a viable `populateAll()` strategy for
production graphs.

---

### Finding 2 — Cycle Detection Alone Does Not Prevent Stack Overflow at Scale

The `mapTracker` algorithm extends naive recursion with a visited-node registry: a `Map<id,
ComponentPopulated>` that short-circuits any revisit of an already-populated node. This
eliminates the infinite-recursion failure and passes both the basic and medium tiers.

However, it **still overflows the call stack at the stress tier (50 000 nodes)**. The reason
is that the visited registry only prevents re-entering a previously processed node — it does
not limit how deeply the call stack grows for *new* nodes. On a 50 000-node graph, a single
DFS path through a region of unvisited nodes can push tens of thousands of recursive frames
before any cycle is encountered. The V8 call stack limit is hit regardless.

The depth of the call stack is bounded by the *diameter* of the unvisited frontier, not by the
presence or absence of cycles. A perfectly acyclic chain of 50 000 nodes would overflow the
same algorithm. Cycle detection is a correctness fix; it is not a scalability fix.

---

### Finding 3 — Two-Pass Wire: The Standout Algorithm

**Two-Pass Wire is the clearest result of this experiment.** It is the fastest correct
algorithm at every tier, uses near-zero heap overhead even at 50 000 nodes, and its
implementation is simpler than any of the other cycle-safe approaches.

#### How It Works

The core insight is to separate **object allocation** from **graph wiring** into two
independent flat loops, eliminating the need for recursion entirely.

**Pass 1 — Pre-allocate all node shells:**

```typescript
for (const comp of flatDatabaseState) {
  visited.set(comp.id, { id: comp.id, name: comp.name, dependencies: [] });
}
```

After this pass, every `ComponentPopulated` object exists in memory with an empty
`dependencies` array. No edges exist yet, but every node has a stable object identity
(a concrete JS reference in the Map).

**Pass 2 — Wire dependency edges:**

```typescript
for (const comp of flatDatabaseState) {
  const node = visited.get(comp.id)!;
  for (const depId of comp.dependencies) {
    node.dependencies.push(visited.get(depId)!);
  }
}
```

Because all node objects already exist, resolving any dependency is a constant-time Map
lookup. Cycles are handled for free: if node A depends on node B and node B depends on node A,
both JS objects were allocated in Pass 1, so Pass 2 simply pushes `visited.get('A')` into B's
dependencies — no special cycle-detection logic required. The result is a properly shared-reference
cyclic object graph, not a copy.

This is structurally analogous to forward-declaration in compiled languages: declare all symbols
first, then resolve references. It achieves O(V + E) time with O(V) additional space (the Map),
and the heap delta at runtime is negligible because no auxiliary structures are created during
wiring.

#### Performance Comparison at Stress (50 000 nodes)

| Algorithm | Time | Heap Delta |
|---|---|---|
| Two-Pass Wire | 81 ms | < 0.1 MB |
| Tarjan SCC Layering | 362 ms | 37 MB |

Two-Pass Wire is **4.5× faster** than Tarjan SCC Layering at the stress tier, and uses a
fraction of the memory. The difference is entirely attributable to Tarjan's auxiliary
structures (index/lowlink maps, SCC membership maps, condensation DAG adjacency sets) that
are not present in the two-pass approach.

---

### Finding 4 — Tarjan SCC Layering: Correct but Over-Engineered for Pure Population

**Tarjan SCC Layering** passes all three tiers and produces a topologically ordered result —
SCCs are processed leaf-first, which is useful for build systems, dependency resolution, and
layered loading. But for the specific goal of `populateAll()` (producing a shared-reference
populated graph), that ordering provides no benefit.

The algorithm's O(V + E) complexity is sound, but the constant factors are larger than
Two-Pass Wire due to the SCC condensation step and Kahn's BFS traversal. If topological
ordering of the output is not a requirement, Tarjan SCC Layering adds complexity without
a corresponding payoff.

---

### Finding 5 — The O(V + E) Floor Is Confirmed Empirically

The `compare.ts` unit-test suite mathematically proves that the graph comparator's operation
count scales exactly linearly with graph size (ratio = scale factor at every tested multiple).
The same O(V + E) guarantee holds for both Two-Pass Wire and Tarjan SCC Layering — both
traverse each node and each edge exactly once.

Naive Recursion and Map Tracker do not finish at the stress tier, so their practical complexity
is O(∞) for cyclic production graphs.

---

## Possible Next Steps

- **Enable the extreme tier (250 000 nodes)** to confirm Two-Pass Wire's linear scaling holds
  past the stress tier and to get a concrete upper-bound data point for very large graphs.
- **Add an iterative Map Tracker variant** that converts the recursive DFS to an explicit stack,
  removing the call-depth limitation while keeping the visited-node registry. This would
  clarify whether the Reference Tracking category can be made scale-safe.
- **Add peak-heap profiling** — the current `ramMb` metric is a heap delta snapshot and misses
  peak usage mid-execution, which is more relevant for memory-constrained environments.
- **Benchmark additional algorithm categories** such as BFS-order population or lazy/proxy-based
  resolution to round out the comparison.
