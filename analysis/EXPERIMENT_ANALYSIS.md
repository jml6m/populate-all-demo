# Cycle-Safe Graph Population in O(V+E): A Two-Pass Solution

This project explores how to fully populate partially hydrated object graphs, showing that cycle-aware graph algorithms can reliably generate self-referential structures without infinite recursion or data loss.

## §1 — Problem Definition: The Need for Deterministic Pointer-to-Object Replacement in Cyclic Graphs

To manage memory and performance, object-relational mappers (ORMs) often utilize **lazy loading** when retrieving complex objects from the database, deferring the load of some data by using placeholders, such as pointers, that only fetch real values when specifically requested. Often there is a need to access the fully constructed object, and while the hydration process is straightforward for Directed Acyclic Graphs (DAGs), the algorithm gets more complex when applied to real-world schemas containing bidirectional or self-referential dependencies.
In the presence of cycles, naive recursive hydration (the most straightforward, unoptimized way to fetch this data) has no safe termination guarantee. Because the traversal follows dependency edges without tracking which nodes it has already wired, cyclic references cause unbounded recursion, which results in stack overflow.

This research proposes a Two-Pass algorithm. By decoupling memory allocation (Pass 1: Vertex Creation) from reference assignment (Pass 2: Edge Wiring), we achieve a cycle-safe solution that operates in $O(V+E)$ time. This approach replaces recursive uncertainty with a deterministic object population algorithm.

---

## §2 — A Recognized Challenge in the Data Layer Ecosystem

The limitations of current hydration strategies are not unique to a single programming language or library but represent a pervasive challenge in the data-layer ecosystem. One example is found in the Mongoose JS library supporting MongoDB ([Issue #16074](https://github.com/Automattic/mongoose/issues/16074)), which, as of version 9.x, does not have built in support for automatic, schema-driven popluation of all referenced paths in the model. Looking at the broader ORM/ODM landscape, the same pattern of cyclic reference challenges appears consistently across other data libraries — visible in their open issue trackers and documentation:

| Library                      | Docs & Eager Loading Strategy                                                                                                                                                                                                                                             | Behavior on Circular/Recursive Relations (Functional Gaps)                                                                                                                                      | Tracked Issue / Discussion                                                                                                        |
| :--------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------- |
| **Mongoose**<br>_(Node.js)_  | [Population docs](https://mongoosejs.com/docs/populate.html)<br>No built-in `populateAll()`; relies on explicit `.populate()` chaining.                                                                                                                                   | **No automatic cycle handling.** Recursive graphs cause infinite loops unless manual depth management/pruning is applied.                                                                       | [#16074](https://github.com/Automattic/mongoose/issues/16074) — Schema-driven `populateAll()`; cites circular refs as motivation. |
| **Sequelize**<br>_(Node.js)_ | [Including Everything](https://sequelize.org/docs/v6/advanced-association-concepts/eager-loading/#including-everything), [Constraints](https://sequelize.org/docs/v6/other-topics/constraints-and-circularities/)<br>Supports `{ include: { all: true, nested: true } }`. | **Throws on circular schemas.** The include mechanism does not automatically prune circularities; developers must explicitly map paths.                                                         | —                                                                                                                                 |
| **TypeORM**<br>_(Node.js)_   | [Eager & Lazy Relations](https://typeorm.io/eager-and-lazy-relations)<br>Supports `eager: true` via entity decorators.                                                                                                                                                    | **Infinite loops on recursion.** Circular eager relations are unsupported; library strictly disallows `eager: true` on both sides of a bidirectional relation.                                  | [#3663](https://github.com/typeorm/typeorm/issues/3663) — `eager: true` on recursive relation causes infinite loop.               |
| **Prisma**<br>_(Node.js)_    | [Self-relations](https://www.prisma.io/docs/orm/prisma-schema/data-model/relations/self-relations)<br>No native "include all" or dynamic hydration.                                                                                                                       | **No full-depth recursion.** Nesting depth must be statically defined via explicit types. Cannot dynamically fetch arbitrary-depth graphs.                                                      | [#3725](https://github.com/prisma/prisma/issues/3725) — Feature Request: Support recursive relationships in queries.              |
| **MikroORM**<br>_(Node.js)_  | [Populating relations](https://mikro-orm.io/docs/populating-relations)<br>Supports wildcards `populate: ['*']`.                                                                                                                                                           | **Serialization crashes.** Hydration is cycle-safe via the internal Identity Map, but downstream native serialization (e.g. `JSON.stringify`) fails on the resulting cyclic graph.              | —                                                                                                                                 |
| **SQLAlchemy**<br>_(Python)_ | [Session Basics](https://docs.sqlalchemy.org/en/20/orm/session_basics.html)<br>Utilizes `lazy='joined'` or `selectinload`.                                                                                                                                                | **Serialization & Insert caveats.** Session identity map resolves read cycles gracefully. Mutual inserts, however, raise `CircularDependencyError` requiring two-pass `post_update=True`.       | —                                                                                                                                 |
| **Hibernate**<br>_(Java)_    | [Fetching strategies](https://docs.hibernate.org/orm/current/userguide/html_single/#fetching)<br>Supports `FetchType.EAGER` and Entity Graphs.                                                                                                                            | **Serialization stack overflows.** Persistence Context (L1 cache) safely wires memory cycles, but Jackson serialization throws `StackOverflowError` without `@JsonIdentityInfo`.                | —                                                                                                                                 |
| **EF Core**<br>_(.NET)_      | [Related Data & Serialization](https://learn.microsoft.com/en-us/ef/core/querying/related-data/#related-data-and-serialization)<br>Supports explicit `.Include()` / `.ThenInclude()`.                                                                                     | **JSON serialization exceptions.** `ChangeTracker` (Identity Map) safely wires cyclic object references, but `System.Text.Json` throws on cycles unless `ReferenceHandler.IgnoreCycles` is set. | —                                                                                                                                 |

These are ORM/ODM libraries operating at the data layer — the abstraction level where population
and eager-loading live. Larger frameworks like Node.js core, Angular, and React operate at
different levels of abstraction and may handle related graph problems internally in ways we have
not investigated here. This experiment focuses specifically on the ORM/ODM population problem,
where the challenge is well-documented and no general iterative solution is widely available.

> **Scope note — hydration vs. serialization.** Several mature frameworks (SQLAlchemy, Hibernate,
> EF Core) solve cyclic hydration via identity maps — architecturally the same principle as the
> two-pass allocate-then-wire strategy tested here. However, their applications still crash when
> the cyclic in-memory graph reaches a serializer (Jackson, `System.Text.Json`, native
> `JSON.stringify`) that lacks its own cycle guard. Hydration correctness and downstream consumer
> viability are architecturally distinct concerns. This experiment measures both as separate stages:
> **Stage 1 — Hydration** (does the algorithm produce a correct in-memory graph?) and **Stage 2 —
> Consumer Probes** (can a downstream consumer process that graph?). See §4 for the two-stage
> results and [Ecosystem Research](./ECOSYSTEM_RESEARCH.md) §3 for extended analysis of the
> serialization boundary.

---

## §3 — The Four Algorithms

**Setup note (how to read benchmark output):** hydration correctness and downstream output/consumer viability are different checks in this benchmark. Stage 1 answers whether the graph was fully populated correctly; Stage 2 answers whether a consumer can safely process that hydrated graph. Timed benchmark measurements are reported for `core-valid` datasets only, while edge-case-only and invalid inputs are handled as preflight admissibility outcomes. See [ECOSYSTEM_RESEARCH.md](./ECOSYSTEM_RESEARCH.md) for deeper rationale and cross-ecosystem context.

### Naive Recursion — the control

Recurse into each dependency. No cycle guard — no memoization. On any cyclic graph — even a
trivial 10-node one — the traversal re-enters a visited node and the call stack overflows.

On an acyclic graph with reused dependencies (the `acyclic-control` tier), the algorithm fails
for a different reason: without memoization, each `populate()` call creates a fresh object, so
a node that appears as a dependency of multiple parents is represented by multiple distinct
objects rather than one coherent materialized node. The comparers detect this hydration mismatch
and report a hydration failure. The failure mode differs from the cyclic case, but the outcome is the
same: Naive Recursion fails on every dataset in this experiment.

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

> **Historical benchmark reference:** the numbers in §4 and §5 are from a CI run on ubuntu-latest
> with Node 22 and a 4 GB heap. Absolute timings and memory figures vary by hardware, Node
> version, and system load — treat them as order-of-magnitude indicators, not canonical benchmarks.
> 250K graph: 250,000 nodes, 500,181 edges. All passing results double-verified (smartCompare + flatCompare).

### Two-Stage Experiment Paradigm

The experiment runner measures each algorithm across two distinct stages:

1. **Stage 1 — Hydration**: did the algorithm produce a correct in-memory graph?  
   Verified by two independent comparers: `smartCompare` (cycle-aware iterative DFS) and
   `flatCompare` (index-based flat comparison against the raw answer file). A result is
   _double-verified_ only when both comparers agree.

2. **Stage 2 — Consumer Probes**: can a downstream consumer process the hydrated graph?  
   Runs only when hydration passes. The experiment tests two consumer probes
   (see `src/utils/consumer.ts`):
   - **`naive-json`** — attempts `JSON.stringify` on the raw graph. On an acyclic graph (the
     `acyclic-control` tier), this succeeds — there are no circular references to trip up the
     serializer. On any cyclic graph, it fails with a circular reference error. Its purpose
     is to demonstrate that hydration success ≠ consumer viability — the same failure mode
     documented for MikroORM, Hibernate, and EF Core in §2.
   - **`cycle-flat`** — converts the graph to an index-based flat representation (the
     `AnswerEntry` format) using an iterative O(V+E) traversal with no recursion. This models
     the ID-Substitution / Custom Cycle-Aware Serialization strategies from
     [Ecosystem Research §3.3](./ECOSYSTEM_RESEARCH.md) and succeeds at any graph scale.

Consumer probes are modeled as a _downstream consumer_ concern, not an algorithm correctness
criterion. A `naive-json` failure does not mean the algorithm is wrong — it means a naive
downstream consumer would crash on the correctly hydrated result.

**Output scope:** The runner shows full-detail output (all three phase lines: Hydration →
Consumer probes → Full Run) for the `acyclic-control` and `basic` tiers. `acyclic-control`
establishes the acyclic-graph baseline (where `naive-json` succeeds); `basic` establishes the
cyclic baseline (where `naive-json` fails and `cycle-flat` is the authoritative passing probe).
Later tiers suppress repeated consumer-probe detail because the probe outcomes are already
established by these two tiers.

### Scale Survivability — Stage 1 (Hydration)

The primary result is which algorithms survive at each tier. Two of four crash at production
scale.

| Algorithm       | acyclic-control (10) | basic (10)        | medium (5K)       | stress (50K)      | extreme (250K)    |
| --------------- | -------------------- | ----------------- | ----------------- | ----------------- | ----------------- |
| Naive Recursion | ❌ Identity mismatch | ❌ Stack overflow | ❌ Stack overflow | ❌ Stack overflow | ❌ Stack overflow |
| Map Tracker     | ✅ Pass              | ✅ Pass           | ✅ Pass           | ❌ Stack overflow | ❌ Stack overflow |
| Tarjan SCC      | ✅ Pass              | ✅ Pass           | ✅ Pass           | ✅ Pass           | ✅ Pass           |
| Two-Pass Wire   | ✅ Pass              | ✅ Pass           | ✅ Pass           | ✅ Pass           | ✅ Pass           |

Naive Recursion fails on `acyclic-control` for a different reason than on cyclic datasets:
without memoization, reused dependency nodes are duplicated into separate objects instead of
being materialized as one coherent graph (hydration mismatch, not stack overflow). Map Tracker is
especially deceptive: it passes at small scale (10–5K nodes), giving false confidence, then
crashes at production scale (50K+). The call stack depth, not the cycle guard, is the binding
constraint.

### Consumer Probe Viability — Stage 2

Stage 2 runs only for tiers where hydration passed. The key insight is that even a correctly
hydrated cyclic graph can crash a naive downstream consumer — the hydration layer did its job,
but the response layer did not.

Consumer probe outcomes depend on whether the graph contains cycles, not on how many nodes it
has. The runner shows full consumer-probe detail for `acyclic-control` and `basic`; later tiers
suppress repeated probe detail because the pattern is already established by those two tiers.

**acyclic-control (10-node DAG — no cycles):**

| Algorithm     | naive-json | cycle-flat                |
| ------------- | ---------- | ------------------------- |
| Map Tracker   | ✅ Pass    | ✅ Pass (output verified) |
| Tarjan SCC    | ✅ Pass    | ✅ Pass (output verified) |
| Two-Pass Wire | ✅ Pass    | ✅ Pass (output verified) |

On an acyclic graph, `JSON.stringify` succeeds — there are no circular references. This
establishes the acyclic-graph baseline and confirms that `naive-json` failures on cyclic tiers
are caused by cycles, not by the algorithm.

**Cyclic datasets (basic and beyond — where hydration ✅):**

| Algorithm     | Tier where hydration ✅       | naive-json                  | cycle-flat                |
| ------------- | ----------------------------- | --------------------------- | ------------------------- |
| Map Tracker   | basic, medium (fails stress+) | ❌ Circular reference error | ✅ Pass (output verified) |
| Tarjan SCC    | all tiers                     | ❌ Circular reference error | ✅ Pass (output verified) |
| Two-Pass Wire | all tiers                     | ❌ Circular reference error | ✅ Pass (output verified) |

The `naive-json` column is uniformly ❌ on cyclic datasets because `JSON.stringify` has no
cycle guard. This is the exact failure mode described for MikroORM (`populate: ['*']` produces
a cyclic graph that crashes `JSON.stringify`), Hibernate (requires `@JsonIdentityInfo`), and
EF Core (requires `ReferenceHandler.IgnoreCycles`).

The authoritative `cycle-flat` column is uniformly ✅, confirming that the iterative
index-based export strategy is safe at every graph scale — and that the verification pipeline
itself (which uses the same format) is consumer-safe by construction.

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

### Time and memory (historical CI reference)

The figures below are from the historical CI run described in the note at the start of §4
(ubuntu-latest, Node 22, 4 GB heap). Absolute numbers vary materially by hardware, Node
version, and system load — observed values on other systems have differed by 2–4× even at the
same graph scale. The relative ordering (Two-Pass Wire consistently faster and lighter than
Tarjan SCC) is stable across environments.

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

Both algorithms are O(V+E). The super-linear constant at 250K is V8 GC pressure on a large
live heap, not algorithmic complexity. The ratios below are computed from the historical CI
reference figures in §4; actual observed ratios vary by environment.

| Metric                | Two-Pass Wire                            | Tarjan SCC           |
| --------------------- | ---------------------------------------- | -------------------- |
| 50K → 250K time ratio | ~7.5× (for 5× nodes, CI reference)       | ~8.5× (CI reference) |
| 50K → 250K RAM ratio  | ~7.3×                                    | ~10.1×               |
| Head-to-head at 250K  | **substantially faster / lighter**       | —                    |
| Speed advantage       | **~4–5× faster** (environment-dependent) | —                    |
| RAM advantage         | **~2–3× less** (environment-dependent)   | —                    |

Tarjan's auxiliary structures (per-node index/lowlink, SCC sets, condensation DAG) add a
constant overhead per node that compounds with GC at large heap sizes. Two-Pass Wire
allocates exactly V+1 objects (the Map plus one shell per node) and nothing else.

---

## §6 — Dataset Scope and Input Validity

The benchmark targets a **root-reachable, single-root** object graph — the exact closure
materialized from one NodeJS/NoSQL request. Every node in a `core-valid` dataset must be
reachable from the root by following dependency edges. Under the current benchmark contract,
that root is **auto-detected from graph structure** as the unique in-degree-zero node (not
declared in the manifest). Datasets with no unique detected root or unreachable nodes are
classified as `edge-case-only`; datasets with duplicate IDs, duplicate edges, or dangling
references are `invalid`. The benchmark also assumes a **simple directed graph** — at most
one directed edge between any ordered pair of nodes. All input admissibility checks are
**preflight**: they run before any timed execution and have no effect on measured algorithm
complexity, latency, or memory.

A full input-validity taxonomy — defining which graph shapes belong in the core benchmark,
which are edge-case-only structures, and which are invalid inputs — is defined in
[`ECOSYSTEM_RESEARCH.md` §6](./ECOSYSTEM_RESEARCH.md#6--dataset-scope-and-input-validity).
