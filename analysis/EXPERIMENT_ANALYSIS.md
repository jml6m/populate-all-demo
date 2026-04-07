# Cycle-Safe Graph Population in O(V+E): A Two-Pass Solution

## §1 — Problem Definition: The Need for Deterministic Pointer-to-Object Replacement in Cyclic Graphs

The transformation of [[flat relational tuples]] into fully populated objects (sometimes referred to as hydration) is a fundamental bridging step between persistence layers and application logic. While this process is computationally trivial for Directed Acyclic Graphs (DAGs) using simple recursive descent, the algorithm gets more complex when applied to real-world schemas containing bidirectional or self-referential dependencies.
In the presence of cycles, naive recursive hydration is inherently non-deterministic. Because the termination condition relies on reaching a leaf node, cyclic references trigger unbounded recursion, leading to catastrophic stack exhaustion. Current industry workarounds typically rely on depth-limited heuristics (e.g., `maxDepth` guards). However, this is fundamentally flawed; the traversal terminates, but
the result is silently truncated, possibly producing an incomplete object graph.

This research proposes a Two-Pass algorithm. By decoupling memory allocation (Pass 1: Vertex Creation) from reference assignment (Pass 2: Edge Wiring), we achieve a cycle-safe solution that operates in $O(V+E)$ time. This approach replaces recursive uncertainty with a deterministic object population algorithm, to be explained in more detail below.

---

## §2 — A Recognized Challenge in the Data Layer Ecosystem

The limitations of current hydration strategies are not localized to a single library but represent a pervasive challenge in the data-layer ecosystem. One example is found in the Mongoose ODM JS library supporting MongoDB [Issue #16074](https://github.com/Automattic/mongoose/issues/16074), which does not have built in support for automatic, schema-driven popluation of all referenced paths in the model. Looking at the broader ORM/ODM landscape, the same pattern of cyclic reference challenges appears consistently across other data libraries — visible in their open issue trackers and documentation:

| Library                 | Issue / Discussion                                                                                                                               | Documentation                                                                                                                                                                                                                                     | Failure Mode                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mongoose**            | [#16074](https://github.com/Automattic/mongoose/issues/16074) — schema-driven `populateAll()` with `maxDepth`; cites circular refs as motivation | [Population docs](https://mongoosejs.com/docs/populate.html) — no built-in recursive populate                                                                                                                                                     | No automatic cycle handling; manual depth management required                                                                                                                                                  |
| **Sequelize**           | —                                                                                                                                                | [Eager Loading — Including Everything](https://sequelize.org/docs/v6/advanced-association-concepts/eager-loading/#including-everything), [Constraints & Circularities](https://sequelize.org/docs/v6/other-topics/constraints-and-circularities/) | `{ include: { all: true, nested: true } }` does not support circular schemas; developers must manually prune cyclic paths from the include definition                                                          |
| **TypeORM**             | [#3663](https://github.com/typeorm/typeorm/issues/3663) — `eager: true` on recursive relation causes infinite loop                               | [Eager/Lazy Relations](https://typeorm.io/eager-and-lazy-relations), [Relations FAQ](https://typeorm.io/relations-faq)                                                                                                                            | Disallows `eager: true` on both sides of a bidirectional relationship; circular eager relations are unsupported                                                                                                |
| **Prisma**              | [#3725](https://github.com/prisma/prisma/issues/3725) — feature request: support recursive relationships in queries                              | [Self-relations](https://www.prisma.io/docs/orm/prisma-schema/data-model/relations/self-relations) — no built-in recursive include; each nesting level must be explicitly written out                                                             | No automatic full-depth include; each depth level requires explicit nesting                                                                                                                                    |
| **MikroORM**            | —                                                                                                                                                | [Populating relations](https://mikro-orm.io/docs/populating-relations) — `populate: ['*']` on circular entities produces an unserialisable cyclic graph; explicit populate hints required                                                         | Hydration via Identity Map + select-in strategy is cycle-safe, but downstream serialization (e.g., `JSON.stringify`) fails on the resulting cyclic graph                                                       |
| **SQLAlchemy** (Python) | —                                                                                                                                                | <a href="https://docs.sqlalchemy.org/en/20/orm/session_basics.html">Session Basics</a>, <a href="https://docs.sqlalchemy.org/en/21/orm/relationship_persistence.html">Relationship Persistence</a>                                                | Session identity map resolves hydration cycles; mutual FK inserts raise `CircularDependencyError` — requires `post_update=True` (a two-pass insert strategy)                                                   |
| **Hibernate** (Java)    | —                                                                                                                                                | <a href="https://docs.hibernate.org/orm/current/userguide/html_single/#fetching">Fetching strategies</a>                                                                                                                                          | Persistence Context (L1 cache) acts as identity map — hydration is cycle-safe; however, Jackson serialization of cyclic graphs causes `StackOverflowError` without `@JsonIdentityInfo` or `@JsonBackReference` |
| **EF Core** (.NET)      | —                                                                                                                                                | <a href="https://learn.microsoft.com/en-us/ef/core/querying/related-data/#related-data-and-serialization">Related Data &amp; Serialization</a>                                                                                                    | `ChangeTracker` identity map resolves hydration cycles; `System.Text.Json` throws on circular navigation properties without `ReferenceHandler.IgnoreCycles`                                                    |

These are ORM/ODM libraries operating at the data layer — the abstraction level where population
and eager-loading live. Larger frameworks like Node.js core, Angular, and React operate at
different levels of abstraction and may handle related graph problems internally in ways we have
not investigated here. This experiment focuses specifically on the ORM/ODM population problem,
where the challenge is well-documented and no general iterative solution is widely available.

> **Scope note — hydration vs. consumer viability.** Several mature frameworks (SQLAlchemy, Hibernate,
> EF Core) solve cyclic hydration via identity maps — architecturally the same principle as the
> two-pass allocate-then-wire strategy tested here. However, their applications still crash when
> the cyclic in-memory graph reaches a serializer (Jackson, `System.Text.Json`, native
> `JSON.stringify`) that lacks its own cycle guard. Hydration correctness and downstream consumer
> viability are architecturally distinct concerns. This experiment measures both as separate stages:
> **Stage 1 — Hydration** (does the algorithm produce a correct cyclic graph?) and **Stage 2 —
> Consumer probes** (can a downstream consumer process that graph?). See §4 for the two-stage
> results and [Ecosystem Research](./ECOSYSTEM_RESEARCH.md) §3 for extended analysis of the
> serialization boundary.

---

## §3 — The Four Algorithms

### Naive Recursion — the control

Recurse into each dependency. No cycle guard. On any cyclic graph — even a trivial 10-node
one — the traversal immediately re-enters a visited node and the call stack overflows.

### Map Tracker — correctness fix, not a scalability fix

Add a `visited` Map: if a node is already in the Map, return the cached result instead of
recursing. This eliminates infinite recursion but does not limit call stack depth. On a
50K-node graph, a single DFS path through unvisited nodes can push tens of thousands of frames
before any cycle is hit. The V8 stack limit is ~10K frames — the algorithm still crashes.

### Tarjan SCC Layering — iterative and correct

First, find every group of nodes that are mutually reachable from each other — these groups
are called Strongly Connected Components (SCCs). For example, if A → B → A, those two nodes
form one SCC. Next, collapse each SCC into a single "super-node" so the graph becomes a DAG
with no cycles. Finally, process that simplified DAG in layer order (topological sort), wiring
all dependencies at each layer before moving to the next. Every step uses an explicit stack or
queue — no recursion at all. Correct at any scale, but requires several auxiliary data
structures to track group membership and the collapsed graph.

### Two-Pass Wire — the winner

**Pass 1** — allocate every node shell into a Map:

```typescript
for (const comp of flatDatabaseState) {
  visited.set(comp.id, { id: comp.id, dependencies: [] });
}
```

**Pass 2** — wire dependency edges via Map lookup:

```typescript
for (const comp of flatDatabaseState) {
  const node = visited.get(comp.id)!;
  for (const depId of comp.dependencies) {
    node.dependencies.push(visited.get(depId)!);
  }
}
```

Cycles resolve automatically: if A depends on B and B depends on A, both JS objects already
exist in the Map, so each side's `.push()` captures a reference to the same object — no cycle
detection required. This is structurally identical to forward-declaration in compiled languages.

By separating allocation from wiring, the algorithm guarantees deterministic termination — no
risk of unbounded stack growth — and zero truncation — no silent `maxDepth` guards that produce
incomplete results.

```mermaid
graph LR
  subgraph "Pass 1 — allocate shells"
    A1["A {}"]
    B1["B {}"]
    C1["C {}"]
    D1["D {}"]
  end
  subgraph "Pass 2 — wire edges"
    A2["A {deps:[B,C]}"]
    B2["B {deps:[D]}"]
    C2["C {deps:[A]}"]
    D2["D {deps:[B]}"]
    A2 --> B2
    A2 --> C2
    C2 --> A2
    B2 --> D2
    D2 --> B2
  end
```

---

## §4 — Results

Benchmark #1 — CI run (ubuntu-latest, Node 22, 4 GB heap). 250K graph: 250,000 nodes,
500,181 edges. All passing results double-verified (smartCompare + flatCompare).

### Two-Stage Experiment Paradigm

The experiment runner measures each algorithm across two distinct stages:

1. **Stage 1 — Hydration**: did the algorithm produce a correct cyclic in-memory graph?  
   Verified by two independent comparers: `smartCompare` (cycle-aware iterative DFS) and
   `flatCompare` (index-based flat comparison against the raw answer file).  A result is
   *double-verified* only when both comparers agree.

2. **Stage 2 — Consumer probes**: can a downstream consumer process the hydrated graph?  
   Runs only when hydration passes.  The experiment tests two consumer probes
   (see `src/utils/consumer.ts`):
   - **`naive-json`** — attempts `JSON.stringify` on the raw cyclic graph.  This probe will
     always fail on any cyclic graph regardless of which algorithm produced it.  Its purpose
     is to demonstrate that hydration success ≠ consumer viability — the same failure mode
     documented for MikroORM, Hibernate, and EF Core in §2.
   - **`cycle-flat`** — converts the graph to an index-based flat representation (the
     `AnswerEntry` format) using an iterative O(V+E) traversal with no recursion.  This models
     the ID-Substitution / Custom Cycle-Aware Serialization strategies from
     [Ecosystem Research §3.3](./ECOSYSTEM_RESEARCH.md) and succeeds at any graph scale.

Consumer viability is a *downstream* concern, not an algorithm correctness criterion.
A `naive-json` failure does not mean the algorithm is wrong — it means a naive downstream
consumer would crash on the correctly hydrated result.

### Scale Survivability — Stage 1 (Hydration)

The primary result is which algorithms survive at each tier. Two of four crash at production
scale.

| Algorithm       | basic (10)        | medium (5K)       | stress (50K)      | extreme (250K)    |
| --------------- | ----------------- | ----------------- | ----------------- | ----------------- |
| Naive Recursion | ❌ Stack overflow | ❌ Stack overflow | ❌ Stack overflow | ❌ Stack overflow |
| Map Tracker     | ✅ Pass           | ✅ Pass           | ❌ Stack overflow | ❌ Stack overflow |
| Tarjan SCC      | ✅ Pass           | ✅ Pass           | ✅ Pass           | ✅ Pass           |
| Two-Pass Wire   | ✅ Pass           | ✅ Pass           | ✅ Pass           | ✅ Pass           |

Map Tracker is especially deceptive: it passes at small scale (10–5K nodes), giving false
confidence, then crashes at production scale (50K+). The call stack depth, not the cycle guard,
is the binding constraint.

### Consumer Viability — Stage 2 (Consumer Probes)

Stage 2 runs only for tiers where hydration passed.  The key insight is that even a correctly
hydrated cyclic graph crashes a naive consumer — the ORM did its job, but the response layer did
not.

Consumer probe behavior is **scale-invariant**: the outcome of `naive-json` and `cycle-flat`
depends on whether the graph contains cycles, not on how many nodes it has.  Both probes are
run in full on the basic (10-node) tier, where correctness is easiest to inspect; results are
the same at every larger scale.  The experiment runner reflects this: probe details are printed
once for the baseline (basic) dataset and omitted for subsequent tiers to keep the output clean.

| Algorithm     | Tier where hydration ✅ | naive-json | cycle-flat |
| ------------- | ----------------------- | ---------- | ---------- |
| Map Tracker   | basic, medium (fails stress+) | ❌ Circular reference error | ✅ Pass (output verified) |
| Tarjan SCC    | all tiers               | ❌ Circular reference error | ✅ Pass (output verified) |
| Two-Pass Wire | all tiers               | ❌ Circular reference error | ✅ Pass (output verified) |

The `naive-json` column is uniformly ❌ for all algorithms that succeed hydration, because
`JSON.stringify` has no cycle guard.  This is the exact failure mode described for MikroORM
(`populate: ['*']` produces a cyclic graph that crashes `JSON.stringify`), Hibernate (requires
`@JsonIdentityInfo`), and EF Core (requires `ReferenceHandler.IgnoreCycles`).

The `cycle-flat` column is uniformly ✅, confirming that the verification pipeline itself
(which uses the same index-based format) is consumer-safe by construction.

### O(V+E) complexity: analytical proof

Both passing algorithms are O(V+E) by construction — this can be verified directly in the source code:

**Two-Pass Wire** (`src/algorithms/schema-driven/01-two-pass-wire.ts`):

- Pass 1: one loop over all V nodes to allocate shells → O(V)
- Pass 2: one loop over all V nodes, and for each node iterates over its outgoing edges — each of the E edges is visited exactly once → O(V+E)
- Total: **O(V+E)**

**Formal notation:**

The allocation phase constructs an Identity Map M over the vertex set V:

```
M = { identity(v) : shell(v) | v ∈ V }    — O(V)
```

The wiring phase resolves every edge e = (u, v) ∈ E by a constant-time lookup in M:

```
∀ e = (u, v) ∈ E : wire(M[identity(u)], M[identity(v)])    — O(E)
```

Total: O(V) + O(E) = **O(V + E)**

**Tarjan SCC Layering** (`src/algorithms/topological/01-tarjan-scc-layering.ts`):

- Iterative Tarjan's SCC: each node and edge visited exactly once → O(V+E)
- Condensation DAG construction: one pass over all V nodes and E edges → O(V+E)
- Kahn's BFS layer assignment: one pass over condensed nodes and edges → O(V+E)
- Pre-allocation and wiring: O(V) + O(V+E)
- Total: **O(V+E)**

### Graph-scale confirmation

This subsection answers two questions: did the graph generator actually produce the expected
graph size at each tier, and did the algorithms produce the complete output? The `smartCompare`
verifier records how many nodes (`nodesProcessed`) and edges (`edgesTraversed`) it visits when
walking the produced output graph. These counts directly measure the output size:

| Tier           | Nodes   | Edges   | Total ops   | Scale ratio                   |
| -------------- | ------- | ------- | ----------- | ----------------------------- |
| stress (50K)   | 50,000  | 99,981  | **149,981** | —                             |
| extreme (250K) | 250,000 | 500,181 | **750,181** | 750,181 / 149,981 ≈ **5.00×** |

The 5.00× scale ratio matches the 5× node-count increase exactly, confirming both that the
graph generator produces consistent edge density across tiers, and that both algorithms output
the complete, correct graph at every scale — not a truncated or partial result.

### Time and memory (supporting evidence)

| Algorithm     | basic (10)      | medium (5K)    | stress (50K)     | extreme (250K)    |
| ------------- | --------------- | -------------- | ---------------- | ----------------- |
| Map Tracker   | 0.3 ms / 0.0 MB | 13 ms / 3.0 MB | ❌               | ❌                |
| Tarjan SCC    | 0.8 ms / 0.1 MB | 46 ms / 9.2 MB | 277 ms / 14.8 MB | 2,360 ms / 149 MB |
| Two-Pass Wire | 0.2 ms / 0.0 MB | 13 ms / 2.9 MB | 67 ms / 7.4 MB   | 502 ms / 54 MB    |

> Times are wall-clock (ms); RAM is heap-delta (MB). Naive Recursion omitted — fails all tiers.

Both passing algorithms are fast enough for production use. The headline insight is not
performance — it is correctness under scale: two of the four approaches fail entirely at
production-scale graphs, including Map Tracker, which passes at small scale and gives false
confidence before crashing.

---

## §5 — Scaling Analysis

Both algorithms are O(V+E). The super-linear constant at 250K is V8 GC pressure on 54–149 MB
of live heap, not algorithmic complexity.

| Metric                | Two-Pass Wire       | Tarjan SCC        |
| --------------------- | ------------------- | ----------------- |
| 50K → 250K time ratio | 7.5× (for 5× nodes) | 8.5×              |
| 50K → 250K RAM ratio  | 7.3×                | 10.1×             |
| Head-to-head at 250K  | **502 ms / 54 MB**  | 2,360 ms / 149 MB |
| Speed advantage       | **4.7× faster**     | —                 |
| RAM advantage         | **2.8× less**       | —                 |

Tarjan's auxiliary structures (per-node index/lowlink, SCC sets, condensation DAG) add a
constant overhead per node that compounds with GC at 149 MB of live heap. Two-Pass Wire
allocates exactly V+1 objects (the Map plus one shell per node) and nothing else.
