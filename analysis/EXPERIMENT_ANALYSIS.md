# Cycle-Safe Graph Population in O(V+E): A Two-Pass Solution

This project explores how to fully populate partially hydrated object graphs, showing that cycle-aware graph algorithms can reliably generate self-referential structures without infinite recursion or data loss.

## §1 — Problem Definition: The Need for Deterministic Pointer-to-Object Replacement in Cyclic Graphs

To manage memory and performance, object-relational mappers (ORMs) often utilize **lazy loading** when retrieving complex objects from the database, deferring the load of some data by using placeholders, such as pointers, that only fetch real values when specifically requested. Often there is a need to access the fully constructed object, and while the hydration process is straightforward for Directed Acyclic Graphs (DAGs), the algorithm gets more complex when applied to real-world schemas containing bidirectional or self-referential dependencies.
In the presence of cycles, naive recursive hydration (the most straightforward, unoptimized way to fetch this data) has no safe termination guarantee. Because the traversal follows dependency edges without tracking which nodes it has already wired, cyclic references cause unbounded recursion, which results in stack overflow.

This research proposes a Two-Pass algorithm. By decoupling memory allocation (Pass 1: Vertex Creation) from reference assignment (Pass 2: Edge Wiring), we achieve a cycle-safe solution that operates in $O(V+E)$ time. This approach replaces recursive uncertainty with a deterministic object population algorithm.

---

## §2 — A Recognized Challenge in the Data Layer Ecosystem

The limitations of current hydration strategies are not unique to a single programming language or library but represent a pervasive challenge in the data-layer ecosystem. A core issue is that "handling cyclic data" decomposes into two distinct gaps: **(A) Hydration Limits** (ability to fully populate objects based on schema alone) and **(B) Serialization Limits** (converting that in-memory graph into a flat string like JSON).

When testing the broader ORM/ODM landscape for cyclic-reference and recursive-population capabilities, severe functional gaps appear across virtually all major data libraries:

| Library / Ecosystem               | Tested Version                          | Eager-Loading & Hydration Strategy                                                                                                                                                                                                                             | Recursive Limits (Hydration & Serialization Gaps)                                                                                                                                                                                                                                               | Tracked Issues / Discussions                                                                                                                                                                                    |
| :-------------------------------- | :-------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mongoose**<br>_(Node.js)_       | v8.3.0                                  | Relies on explicit `.populate()` chaining. No built-in `populateAll()` [[1]](https://mongoosejs.com/docs/populate.html)                                                                                                                                        | **Hydration Gap:** Developers must explicitly chain together `.populate()` parameters.                                                                                                                                                                                                          | [#16074](https://github.com/Automattic/mongoose/issues/16074) — Schema-driven `populateAll()`. Workaround: bounded-depth manual recursive wrapper or `$graphLookup` (MongoDB aggregation) as an architectural alternative for multi-hop traversal. |
| **Sequelize**<br>_(Node.js)_      | v6.37.2                                 | `{ include: { all: true, nested: true } }` [[1]](https://sequelize.org/docs/v6/advanced-association-concepts/eager-loading/#including-everything) [[2]](https://sequelize.org/docs/v6/other-topics/constraints-and-circularities/)                             | **Hydration Gap:** In self-referential trees, this method arbitrarily truncates recursive objects at depth 1 to prevent infinite SQL joins.                                                                                                                                                     | Workaround: manually chain nested `include` hashes to a bounded depth, or fetch a flat result set and assemble the graph in application memory. Neither approach is unbounded.                                   |
| **TypeORM**<br>_(Node.js)_        | v0.3.20                                 | `eager: true` via entity decorators [[1]](https://typeorm.io/eager-and-lazy-relations)                                                                                                                                                                         | **Hydration Gap:** Circular eager relations are disallowed. `eager: true` cannot be enabled on both sides of a bidirectional relation; a positive control with only one eager side succeeds.                                                                                                    | [#3663](https://github.com/typeorm/typeorm/issues/3663) — `eager: true` on recursive causes loop. Alternative modeling approach: `TreeRepository` with closure-table or materialized-path strategy for hierarchical data, though this is a different schema pattern rather than a direct fix for bidirectional eager loading. |
| **Prisma**<br>_(Node.js)_         | v5.12.0                                 | Explicit `include` mapping [[1]](https://mikro-orm.io/docs/populating-relations)                                                                                                                                                                               | **Hydration Gap:** Each nesting level must be explicitly typed in the query argument. Data truncates at the specified depth.                                                                                                                                                                    | [#3725](https://github.com/prisma/prisma/issues/3725) — Support recursive relationships. Workaround: explicit nested `include` chains to a bounded depth, or a raw SQL recursive CTE for unbounded traversal (bypasses the Prisma type system). |
| **MikroORM**<br>_(Node.js)_       | v6.6.13                                 | `populate: ['*']` [[1]](https://mikro-orm.io/docs/populating-relations#populating-all-relations)                                                                                                                                                               | **Hydration Gap:** `populate: ['*']` strictly halts at depth 1. Requires hardcoded paths for deeper traversal. MikroORM's Identity Map can correctly hydrate cyclic graphs when explicit paths are provided; the wildcard limitation is a query-API constraint, not a fundamental hydration failure. | Workaround: hardcode explicit populate paths (e.g. `['deps', 'deps.deps']`) to the required depth. Serialization still requires a cycle-aware strategy — standard `JSON.stringify` will throw on the correctly hydrated cyclic result. |
| **SQLAlchemy**<br>_(Python)_      | v2.0.49                                 | `joinedload` with `join_depth` limits, or Bulk Loading via Identity Map [[1]](https://docs.sqlalchemy.org/en/20/orm/session_basics.html) [[2]](https://docs.sqlalchemy.org/en/20/orm/self_referential.html)                                                    | **Hydration Gap (Partial) & Serialization Gap:** No unbounded wildcard deep-fetch (recursive schemas require a `join_depth` limit to prevent infinite SQL joins). Identity Map bulk loads cleanly wire cyclic objects in memory. However, downstream serialization (`json.dumps`) still errors. | Official mechanisms: `post_update=True` on a relationship breaks circular FK write ordering via a deferred `UPDATE` (a two-pass insert strategy). The Session's Identity Map handles cyclic reads. Serialization requires a custom cycle-aware approach — standard `json.dumps` has no cycle guard. |
| **Hibernate/Jackson**<br>_(Java)_ | v6.6.0 (Hibernate)<br>v2.17.0 (Jackson) | Persistence Context acts as an Identity Map [[1]](https://javadoc.io/doc/com.fasterxml.jackson.core/jackson-databind/2.10.3/com/fasterxml/jackson/databind/ObjectMapper.html) [[2]](https://docs.hibernate.org/orm/6.6/introduction/html_single/#associations) | **Serialization Gap:** Persistence Context (L1 Cache) acts as an identity map and resolves memory cycles gracefully (e.g. A↔B). However, standard Jackson serialization throws `JsonMappingException` (Infinite Recursion). Workarounds mutate payloads or drop data.                           | Official Jackson annotations: `@JsonIdentityInfo` (replaces revisited objects with their ID — full fidelity); `@JsonManagedReference` / `@JsonBackReference` (omits the back-reference side — data loss); `@JsonIgnore` (omits the field entirely — data loss). DTO projection is also viable when response shape is controlled. |
| **EF Core**<br>_(.NET)_           | v10.0.7                                 | Statically chained `.Include()` / `.ThenInclude()` [[1]](https://learn.microsoft.com/en-us/ef/core/querying/related-data/eager) [[2]](https://learn.microsoft.com/en-us/ef/core/querying/related-data/serialization)                                           | **Hydration Gap (Partial) & Serialization Gap:** Requires statically chained `.ThenInclude()` mapping (no unbounded wildcard). `ChangeTracker` safely wires cycles in RAM, but `System.Text.Json` throws `JsonException` upon hitting those cycles. Workarounds mutate payloads.                | Official serializer options: `ReferenceHandler.IgnoreCycles` (sets looping references to `null` — cycle truncation, data loss); `ReferenceHandler.Preserve` (emits non-standard `$id`/`$ref` metadata — breaks standard JSON consumers); `[JsonIgnore]` (omits the field — data loss). DTO projection avoids the issue at the cost of manual mapping. |
| **ActiveRecord**<br>_(Ruby)_      | v8.1.3                                  | Explicit `.includes()` depth limits [[1]](https://api.rubyonrails.org/classes/ActiveRecord/Associations/ClassMethods.html) [[2]](https://docs.ruby-lang.org/en/3.3/JSON.html)                                                                                  | **Hydration & Serialization Gaps:** Hydration silently falls back to lazy-loading (N+1 queries) if traversal exceeds predefined `.includes()` depth. Built-in `.to_json` triggers `JSON::NestingError` or `SystemStackError`.                                                                   | Workarounds: customize `as_json` or `to_json` with explicit `only:`/`except:` options to control which associations are serialized and break cycles; use a DTO-style serializer (e.g. custom serializer objects) to shape the response without recursive object references. These approaches trade graph fidelity for serialization safety. |

These are ORM/ODM libraries operating at the data layer — the abstraction level where population
and eager-loading are commonly tested. Frontend frameworks like Angular and React operate at
different parts of the technology stack and may handle related graph problems internally in ways we have
not investigated here. This experiment focuses specifically on the ORM/ODM population problem.

> **Scope note — hydration vs. serialization.** Several mature frameworks (SQLAlchemy, Hibernate) solve cyclic hydration via identity maps — architecturally the same principle as the
> two-pass allocate-then-wire strategy tested here. However, their applications still crash when
> the cyclic in-memory graph reaches a serializer that lacks its own cycle guard. Hydration correctness and downstream consumer
> viability are architecturally distinct concerns. This experiment measures both as separate stages:
> **Stage 1 — Hydration** (does the algorithm produce a correct in-memory graph?) and **Stage 2 —
> Consumer Probes** (can a downstream consumer process that graph?). See §3 and §4 for how these
> stages are tested, and [Ecosystem Research §3](./ECOSYSTEM_RESEARCH.md#3--the-serialization-boundary) for extended analysis of the
> serialization boundary.

---

## §3 — Experiment Design

### Algorithms under test

Four algorithms are benchmarked, representing distinct approaches to the population problem:

| Algorithm | Category | Core strategy |
| --- | --- | --- |
| **Naive Recursion** | Reference Tracking | Recursive DFS, no cycle guard, no memoization. Serves as the failing control. |
| **Map Tracker** | Reference Tracking | Recursive DFS with a `visited` Map to avoid re-entering the same node. Eliminates infinite recursion but not stack overflow at scale. |
| **Tarjan SCC Layering** | Topological | Iterative Tarjan SCC → condensation DAG → Kahn's BFS layer assignment → iterative wiring. Fully iterative, no call-stack dependency. |
| **Two-Pass Wire** | Schema-Driven | Pass 1 allocates all node shells into a Map; Pass 2 wires edges via Map lookup. Zero recursion, minimal auxiliary structures. |

### Dataset tiers

The experiment uses five dataset tiers, generated by `npm run generate` and stored in the `data/` directory:

| Tier | Graph type | Scale (nodes) | Purpose |
| --- | --- | --- | --- |
| `acyclic-control` | Directed acyclic graph (DAG) with reused dependencies | ~10 | Acyclic baseline. Exposes memoization failures (Naive Recursion) independent of cycle handling. |
| `basic` | Cyclic graph (bidirectional edges, mutual references) | ~10 | Cyclic baseline. The smallest graph that triggers stack overflow and establishes consumer-probe patterns for all later tiers. |
| `medium` | Cyclic graph | ~5K | Mid-scale correctness and timing check. |
| `stress` | Cyclic graph | ~50K | Production-scale. Exposes Map Tracker's stack-depth failure at realistic graph sizes. |
| `extreme` | Cyclic graph | ~250K | Upper bound. Verifies that the surviving algorithms scale to very large graphs with acceptable resource consumption. |

### Two-stage evaluation

Each algorithm is evaluated in two sequential stages:

**Stage 1 — Hydration:** did the algorithm produce a correct in-memory graph?

The result is verified by two independent comparers:
- **`smartCompare`** — cycle-aware iterative DFS that walks the produced graph and compares it node-by-node against the expected answer.
- **`flatCompare`** — index-based flat comparison; serializes the produced graph to the `AnswerEntry` format and compares it against the stored answer file without traversing the cyclic object graph directly.

A result is reported as _double-verified_ only when both comparers agree.

**Stage 2 — Consumer Probes:** can a downstream consumer process the hydrated graph?

Stage 2 runs only when Stage 1 passes. It is a separate measurement of consumer viability, not a correctness criterion — a probe failure means a naive downstream consumer would crash on a correctly hydrated result, not that the algorithm is wrong.

### Consumer probes

Two probes are run against each passing hydration result:

- **`naive-json`** — calls `JSON.stringify` on the raw graph. Succeeds on the `acyclic-control` dataset (no circular references). Fails on all cyclic datasets with a circular reference error. Its purpose is to demonstrate that hydration success does not guarantee consumer viability — the same failure mode documented for MikroORM, Hibernate, and EF Core in §2.

- **`cycle-flat`** — converts the graph to an index-based flat representation (the `AnswerEntry` format) using an iterative O(V+E) traversal with no recursion. This mirrors the ID-Substitution / Custom Cycle-Aware Serialization strategies described in [Ecosystem Research §3](./ECOSYSTEM_RESEARCH.md#3--the-serialization-boundary). It passes at every graph scale where hydration succeeds.

### Output scope policy

The runner shows full three-phase detail (Hydration → Consumer probes → Full Run) for the `acyclic-control` and `basic` tiers only:

- `acyclic-control` establishes the acyclic baseline (where `naive-json` succeeds and all passing algorithms are double-verified).
- `basic` establishes the cyclic baseline (where `naive-json` fails and `cycle-flat` is the authoritative probe).

Later tiers (`medium`, `stress`, `extreme`) suppress repeated consumer-probe detail because the probe outcome patterns are fully established by these two tiers. Known failures (algorithms that crashed at an earlier cyclic tier) are also omitted from later tiers — they deterministically fail at all larger scales and re-running adds no information.

---

## §4 — Results

> **Note on figures:** Timing and RAM measurements below are from a recent local run. Absolute numbers vary by hardware, Node version, and system load — treat them as order-of-magnitude indicators, not canonical benchmarks. The relative ordering across algorithms is consistent across environments.

### Scale Survivability — Stage 1 (Hydration)

| Algorithm | acyclic-control | basic | medium | stress | extreme |
| --- | --- | --- | --- | --- | --- |
| Naive Recursion | ❌ Identity mismatch | ❌ Stack overflow | ❌ (known failure) | ❌ (known failure) | ❌ (known failure) |
| Map Tracker | ✅ Pass | ✅ Pass | ✅ Pass | ❌ Stack overflow | ❌ (known failure) |
| Tarjan SCC Layering | ✅ Pass | ✅ Pass | ✅ Pass | ✅ Pass | ✅ Pass |
| Two-Pass Wire | ✅ Pass | ✅ Pass | ✅ Pass | ✅ Pass | ✅ Pass |

**Naive Recursion** fails on every tier. On `acyclic-control`, the failure mode is identity mismatch rather than stack overflow — without memoization, reused dependency nodes are duplicated into separate objects rather than materialized as a single coherent graph. On all cyclic tiers, it stack-overflows.

**Map Tracker** is deceptive: it passes comfortably through `basic` and `medium`, then fails at `stress` with a stack overflow. Adding a `visited` Map eliminates infinite recursion but does nothing to limit call-stack depth. On a 50K-node graph, a single DFS path through unvisited nodes can push tens of thousands of frames before hitting a previously visited node. The V8 call-stack limit (~10K frames) is the binding constraint, not the cycle guard.

**Tarjan SCC Layering** and **Two-Pass Wire** pass all five tiers. Both are fully iterative — no recursion, no call-stack dependency.

### Consumer Probe Results — Stage 2

Consumer probes run only where Stage 1 passed. The pattern is established by the first two tiers:

**acyclic-control (DAG — no cycles):**

| Algorithm | naive-json | cycle-flat |
| --- | --- | --- |
| Map Tracker | ✅ Pass | ✅ Pass (output verified) |
| Tarjan SCC Layering | ✅ Pass | ✅ Pass (output verified) |
| Two-Pass Wire | ✅ Pass | ✅ Pass (output verified) |

On an acyclic graph, `JSON.stringify` succeeds because there are no circular references. This establishes the acyclic baseline: `naive-json` failures on cyclic tiers are caused by cycles in the hydrated graph, not by algorithmic error.

**basic and all later cyclic tiers (where hydration ✅):**

| Algorithm | naive-json | cycle-flat |
| --- | --- | --- |
| Map Tracker (basic, medium) | ❌ Circular reference error | ✅ Pass (output verified) |
| Tarjan SCC Layering (all tiers) | ❌ Circular reference error | ✅ Pass (output verified) |
| Two-Pass Wire (all tiers) | ❌ Circular reference error | ✅ Pass (output verified) |

`naive-json` fails uniformly on cyclic datasets. This is the same failure mode documented for Hibernate (requires `@JsonIdentityInfo`), EF Core (requires `ReferenceHandler.IgnoreCycles`), and MikroORM (wildcard populate produces a cyclic graph that crashes `JSON.stringify`). The `cycle-flat` probe passes at every scale, confirming that an iterative index-based export strategy is consumer-safe regardless of graph size.

### Timing and Memory

| Algorithm | acyclic-control | basic | medium | stress | extreme |
| --- | --- | --- | --- | --- | --- |
| Naive Recursion | ❌ | ❌ | ❌ | ❌ | ❌ |
| Map Tracker | 0.6 ms / <0.1 MB | 0.1 ms / <0.1 MB | 25 ms / <0.1 MB | ❌ | ❌ |
| Tarjan SCC Layering | 1.2 ms / <0.1 MB | 0.2 ms / <0.1 MB | 24 ms / 7.0 MB | 305 ms / 28 MB | 2.1 s / 255 MB |
| Two-Pass Wire | 0.3 ms / <0.1 MB | <0.1 ms / <0.1 MB | 12 ms / 2.7 MB | 175 ms / <0.1 MB | 1.0 s / 179 MB |

> Times are wall-clock; RAM is heap-delta. All passing results are double-verified (smartCompare + flatCompare).

Both surviving algorithms comfortably handle the largest tier tested (250K nodes, ~500K edges). Two-Pass Wire is consistently faster and leaner: it allocates only the node shells and a single Map, with no auxiliary SCC tracking structures. Tarjan SCC Layering carries per-node auxiliary state (index, lowlink, SCC membership, condensation DAG) that compounds with GC pressure at large heap sizes.

The headline result is **correctness under scale**, not raw performance. Two of the four algorithms fail entirely at production-scale graphs — including Map Tracker, which passes at small scale and gives false confidence before crashing at 50K nodes.

---

## §5 — Scaling Profile

Both surviving algorithms are O(V+E). The analytical proofs are in [Ecosystem Research §1](./ECOSYSTEM_RESEARCH.md#1--completeness-as-a-global-property).

The relative resource trends from the measured results above:

| Metric | Two-Pass Wire | Tarjan SCC Layering |
| --- | --- | --- |
| Passes all tiers | ✅ | ✅ |
| Memory at extreme (250K) | 179 MB | 255 MB |
| Time at extreme (250K) | 1.0 s | 2.1 s |
| Memory at stress (50K) | <0.1 MB | 28 MB |
| Relative advantage | ~2× faster, substantially lighter at scale | — |

The memory difference is most pronounced at large scales where Tarjan's auxiliary structures (per-node index/lowlink arrays, SCC membership sets, condensation DAG edges) accumulate alongside the live heap. Two-Pass Wire allocates exactly V+1 objects (one shell per node plus the Map) and nothing else.

Both algorithms are fast enough for production use at any of the tested scales. The more meaningful distinction is that Tarjan SCC Layering has meaningfully higher memory overhead at scale — which matters in memory-constrained environments.

---

## §6 — Benchmark Scope

The benchmark targets a **root-reachable, single-root** object graph — the exact closure materialized from one request. Every node in a `core-valid` dataset must be reachable from the root by following dependency edges. The root is auto-detected from graph structure as the unique in-degree-zero node.

Key constraints:
- **Simple directed graph** — at most one directed edge between any ordered pair of nodes.
- **Preflight validation** — all admissibility checks run before any timed execution and have no effect on measured complexity, latency, or memory.
- **`acyclic-control` is a DAG control tier**, not a cyclic benchmark tier.
- Orphaned nodes, dangling references, and duplicate edges are excluded from the core benchmark (classified as `edge-case-only` or `invalid`).

A full input-validity taxonomy is in [`ECOSYSTEM_RESEARCH.md` §6](./ECOSYSTEM_RESEARCH.md#6--dataset-scope-and-input-validity).
