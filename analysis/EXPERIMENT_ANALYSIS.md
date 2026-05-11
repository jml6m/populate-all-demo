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
| **Mongoose**<br>_(Node.js)_       | v8.3.0                                  | Relies on explicit `.populate()` chaining. No built-in `populateAll()` [[1]](https://mongoosejs.com/docs/populate.html)                                                                                                                                        | **Hydration Gap:** There is no API to resolve the full schema in a single call. Self-referential schemas have no safe depth limit — each association level must be named explicitly, and nodes beyond the last named level go unfetched.                                                         | [#16074](https://github.com/Automattic/mongoose/issues/16074) — Tracks the community discussion on whether Mongoose should support a schema-driven `populateAll()` that safely traverses schemas of arbitrary depth, including cycles. |
| **Sequelize**<br>_(Node.js)_      | v6.37.2                                 | `{ include: { all: true, nested: true } }` [[1]](https://sequelize.org/docs/v6/advanced-association-concepts/eager-loading/#including-everything) [[2]](https://sequelize.org/docs/v6/other-topics/constraints-and-circularities/)                             | **Hydration Gap:** In self-referential models, this method truncates recursive objects at depth 1 to prevent infinite SQL joins.                                                                                                                                                                 | The depth cap reflects a structural SQL constraint: a query cannot self-join a tree of unbounded depth. Sequelize enforces a ceiling rather than letting the query builder recurse without bound.               |
| **TypeORM**<br>_(Node.js)_        | v0.3.20                                 | `eager: true` via entity decorators [[1]](https://typeorm.io/eager-and-lazy-relations)                                                                                                                                                                         | **Hydration Gap:** Circular eager relations are disallowed at the entity level. `eager: true` cannot be set on both sides of a bidirectional relation; a positive control with only one eager side succeeds.                                                                                    | [#3663](https://github.com/typeorm/typeorm/issues/3663) — Tracks the open question of whether TypeORM should handle bidirectional recursive `eager: true` safely, e.g. by applying a cycle limit at initialization rather than crashing. |
| **Prisma**<br>_(Node.js)_         | v5.12.0                                 | Explicit `include` mapping [[1]](https://www.prisma.io/docs/orm/prisma-client/queries/relation-queries)                                                                                                                                                        | **Hydration Gap:** Recursive self-relations require statically declaring every nesting level in the query. The result truncates at the deepest declared level; the Prisma Client type system provides no mechanism for unbounded depth.                                                           | [#3725](https://github.com/prisma/prisma/issues/3725) — Open discussion on first-class recursive relation support in Prisma Client, including whether dynamic or cursor-based depth traversal is feasible within the current type system. |
| **MikroORM**<br>_(Node.js)_       | v6.6.13                                 | `populate: ['*']` [[1]](https://mikro-orm.io/docs/populating-relations#populating-all-relations)                                                                                                                                                               | **Hydration Gap:** `populate: ['*']` strictly halts at depth 1; deeper traversal requires hardcoded explicit paths. The Identity Map can correctly hydrate cyclic graphs when explicit paths are given — the wildcard limit is a query-API constraint, not a fundamental hydration failure.     | The wildcard depth cap is documented as intentional. Community discussion centers on whether the Identity Map's cycle-safe in-memory wiring makes it safe to enable deeper wildcard traversal. |
| **SQLAlchemy**<br>_(Python)_      | v2.0.49                                 | `joinedload` with `join_depth` limits, or bulk loading via Identity Map [[1]](https://docs.sqlalchemy.org/en/20/orm/session_basics.html) [[2]](https://docs.sqlalchemy.org/en/20/orm/self_referential.html)                                                    | **Hydration Gap (Partial) & Serialization Gap:** Self-referential schemas require an explicit `join_depth` cap to prevent infinite SQL joins. The Identity Map cleanly wires cyclic objects in memory, but downstream `json.dumps` still errors on the resulting circular references.           | [[1]](https://docs.sqlalchemy.org/en/20/orm/relationship_persistence.html) — Documents `post_update=True` for circular FK write ordering (a deferred UPDATE approach). Downstream JSON serialization of cyclic objects is treated as application-layer responsibility outside SQLAlchemy's scope. |
| **Hibernate/Jackson**<br>_(Java)_ | v6.6.0 (Hibernate)<br>v2.17.0 (Jackson) | Persistence Context acts as an Identity Map [[1]](https://javadoc.io/doc/com.fasterxml.jackson.core/jackson-databind/2.17.0/com/fasterxml/jackson/databind/ObjectMapper.html) [[2]](https://docs.hibernate.org/orm/6.6/introduction/html_single/#associations) | **Serialization Gap:** The Persistence Context resolves memory cycles correctly (e.g. A↔B are wired without duplication). Passing that graph to standard Jackson serialization throws `JsonMappingException` because the serializer has no cycle guard.                                          | [[1]](https://www.baeldung.com/jackson-bidirectional-relationships-and-infinite-recursion) — Canonical guide on Jackson's annotation-based options. `@JsonIdentityInfo` replaces revisited objects with their ID (full fidelity); `@JsonManagedReference`/`@JsonBackReference`/`@JsonIgnore` suppress the back-reference side (data loss). |
| **EF Core**<br>_(.NET)_           | v10.0.7                                 | Statically chained `.Include()` / `.ThenInclude()` [[1]](https://learn.microsoft.com/en-us/ef/core/querying/related-data/eager) [[2]](https://learn.microsoft.com/en-us/ef/core/querying/related-data/serialization)                                           | **Hydration Gap (Partial) & Serialization Gap:** Requires statically chained `.ThenInclude()` — no unbounded wildcard. `ChangeTracker` wires cycles safely in memory, but `System.Text.Json` throws `JsonException` upon serializing them.                                                      | Two built-in serialization options are documented in the official guide: `ReferenceHandler.IgnoreCycles` (sets looping references to `null`) and `ReferenceHandler.Preserve` (emits `$id`/`$ref` metadata incompatible with standard JSON consumers) — both trade graph fidelity for safety. |
| **ActiveRecord**<br>_(Ruby)_      | v8.1.3                                  | Explicit `.includes()` depth limits [[1]](https://api.rubyonrails.org/classes/ActiveRecord/Associations/ClassMethods.html) [[2]](https://docs.ruby-lang.org/en/3.3/JSON.html)                                                                                  | **Hydration & Serialization Gaps:** Traversal beyond the declared `.includes()` depth silently falls back to N+1 lazy queries. Built-in `.to_json` triggers `JSON::NestingError` or `SystemStackError` on cyclic objects.                                                                       | Rails convention treats API response shaping as a presentation-layer concern: serialization should be defined explicitly (via `as_json` options or a custom serializer object) rather than derived automatically from recursive ORM relationships. |

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
> stages are tested, and [Ecosystem Research §3](./ECOSYSTEM_RESEARCH.md#2--the-serialization-boundary) for extended analysis of the
> serialization boundary.

---

## §3 — Experiment Design

### Algorithms under test

Four algorithms are benchmarked, representing distinct approaches to the population problem:

| Algorithm | Approach | Core strategy |
| --- | --- | --- |
| **Naive Recursion** | Uncached recursion | Recursive DFS with no cycle guard and no memoization. Included as the failing control to show what goes wrong without any safeguards. |
| **Map Tracker** | Memoized recursion | Recursive DFS that caches each visited node in a Map so it is never processed twice. Prevents infinite loops but still uses the call stack, which overflows on large graphs. |
| **Tarjan SCC Layering** | Iterative topological ordering | Finds every group of mutually-dependent nodes (Strongly Connected Components), collapses them so the graph has no cycles, then wires dependencies level-by-level using a queue — all steps use loops, not recursion. |
| **Two-Pass Wire** | Iterative two-pass | Pass 1 creates every node object and stores it in a lookup Map. Pass 2 wires the dependency edges by looking up the already-created objects. No recursion, no cycle detection needed. |

### Dataset tiers

The experiment uses five dataset tiers, generated by `npm run generate` and stored in the `data/` directory:

| Tier | Graph type | Scale (nodes) | Purpose |
| --- | --- | --- | --- |
| `acyclic-control` | DAG where multiple parents can share the same child node (diamond-shaped dependency patterns, no cycles) | ~10 | Acyclic baseline. Hydration succeeds for all algorithms except Naive Recursion, which creates duplicate copies of shared nodes instead of one shared object. Tests memoization correctness independent of cycle handling. |
| `basic` | Cyclic graph (bidirectional edges, mutual references) | ~10 | Cyclic baseline. Naive Recursion stack-overflows; the remaining three algorithms hydrate successfully. Establishes the consumer-probe outcome pattern for all larger cyclic tiers. |
| `medium` | Cyclic graph | ~5K | Mid-scale correctness and timing check. |
| `stress` | Cyclic graph | ~50K | Large-scale test with 50,000 nodes and ~100,000 edges. Exposes Map Tracker's call-stack limit, which is hit on dense graphs even when the cycle guard prevents infinite loops. |
| `extreme` | Cyclic graph | ~250K | Maximum-scale test, sized to fill roughly 200–250 MB of heap — within the available memory of a typical developer machine. Confirms the surviving algorithms remain viable at the upper end of the tested range. |

### Two-stage evaluation

Each algorithm is evaluated in two sequential stages:

**Stage 1 — Hydration:** did the algorithm produce a correct in-memory graph?

The result is verified by two independent comparers. Stage 1 passes only when both agree — if either fails, the run is reported as a hydration failure (or a conflict if one passes and the other fails):
- **`smartCompare`** — cycle-aware iterative DFS that walks the live object references in the produced graph and compares it node-by-node against the expected answer. No serialization is involved; it navigates JavaScript object references directly.
- **`flatCompare`** — builds an identity map (object → index), converts the produced graph to an index-based representation, and compares it entry-by-entry against the pre-computed answer file. The answer file is the ground truth generated by `npm run generate`; comparing against it is a structural equality check, not a consumer operation. This also catches bugs that would fool `smartCompare` by affecting how the expected answer is loaded.

Neither comparer serializes the graph or simulates downstream use — those questions are left entirely to Stage 2.

**Stage 2 — Consumer Probes:** can a downstream consumer process the hydrated graph?

Stage 2 runs only when Stage 1 passes. It is a separate measurement of consumer viability, not a correctness criterion — a probe failure means a naive downstream consumer would crash on a correctly hydrated result, not that the algorithm is wrong.

### Consumer probes

Two probes are run against each passing hydration result:

- **`naive-json`** — calls `JSON.stringify` on the raw graph. Succeeds on the `acyclic-control` dataset (no circular references). Fails on all cyclic datasets with a circular reference error. Its purpose is to demonstrate that hydration success does not guarantee consumer viability, mirroring the same serialization gap documented across the ecosystem in [§2](#2--a-recognized-challenge-in-the-data-layer-ecosystem).

- **`cycle-flat`** — converts the graph to an index-based flat representation (the `AnswerEntry` format) using an iterative O(V+E) traversal with no recursion. This mirrors the ID-Substitution / Custom Cycle-Aware Serialization strategies described in [Ecosystem Research §3](./ECOSYSTEM_RESEARCH.md#2--the-serialization-boundary). It passes at every graph scale where hydration succeeds.

### Output scope policy

The runner shows full three-phase detail (Hydration → Consumer probes → Full Run) for the `acyclic-control` and `basic` tiers only:

- `acyclic-control` establishes the acyclic baseline (where `naive-json` succeeds and all passing algorithms cleared both comparers).
- `basic` establishes the cyclic baseline (where `naive-json` fails and `cycle-flat` is the authoritative probe).

Later tiers (`medium`, `stress`, `extreme`) suppress repeated consumer-probe detail because the probe outcome patterns are fully established by these two tiers. Known failures (algorithms that crashed at an earlier cyclic tier) are also omitted from later tiers — they deterministically fail at all larger scales and re-running adds no information.

---

## §4 — Results

> **Note on figures:** Timing and RAM measurements below are from a recent local run. Absolute numbers vary by hardware, Node version, and system load — treat them as order-of-magnitude indicators, not canonical benchmarks. The relative ordering across algorithms is consistent across environments.

### Scale Survivability — Stage 1 (Hydration)

| Algorithm | acyclic-control | basic | medium | stress | extreme |
| --- | --- | --- | --- | --- | --- |
| Naive Recursion | ❌ Identity mismatch | ❌ Stack overflow | ❌ Stack overflow | ❌ Stack overflow | ❌ Stack overflow |
| Map Tracker | ✅ Pass | ✅ Pass | ✅ Pass | ❌ Stack overflow | ❌ Stack overflow |
| Tarjan SCC Layering | ✅ Pass | ✅ Pass | ✅ Pass | ✅ Pass | ✅ Pass |
| Two-Pass Wire | ✅ Pass | ✅ Pass | ✅ Pass | ✅ Pass | ✅ Pass |

**Naive Recursion** fails on every tier. On `acyclic-control`, it fails because of how shared nodes are handled: when node D is a dependency of both node B and node C, the algorithm visits D twice and creates two separate copies of it — so B and C end up pointing to different objects that happen to have the same ID, instead of both pointing to the same single object. The comparers detect this duplication and report a mismatch. On all cyclic datasets, the failure is more severe: populating node A requires populating B (which A depends on), and populating B requires populating A (which B depends on). The algorithm calls itself recursively without end, adding a new level to the function call chain on every step until the program's built-in call limit is exceeded and it crashes.

**Map Tracker** is deceptive: it passes through `acyclic-control`, `basic`, and `medium` before failing at `stress`. Adding a `visited` Map prevents the algorithm from entering an infinite loop — when it encounters a node it has already started processing, it returns the cached result. But this does not reduce how deeply the functions call each other. On a 50,000-node graph, following a chain of previously unvisited nodes can push thousands of nested function calls onto the call stack before a cached node is hit. JavaScript enforces a maximum call stack depth (roughly 10,000–15,000 frames), and this limit is exceeded before the algorithm finishes.

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
| Map Tracker | ❌ Circular reference error | ✅ Pass (output verified) |
| Tarjan SCC Layering | ❌ Circular reference error | ✅ Pass (output verified) |
| Two-Pass Wire | ❌ Circular reference error | ✅ Pass (output verified) |

`naive-json` fails uniformly on cyclic datasets because `JSON.stringify` has no cycle guard — it crashes on any graph that contains circular references, regardless of how correctly the algorithm hydrated it. The `cycle-flat` probe passes at every scale, confirming that an iterative index-based approach can safely export the graph at any size.

### Timing and Memory

| Algorithm | acyclic-control | basic | medium | stress | extreme |
| --- | --- | --- | --- | --- | --- |
| Naive Recursion | ❌ | ❌ | ❌ | ❌ | ❌ |
| Map Tracker | 0.6 ms / <0.1 MB | 0.1 ms / <0.1 MB | 25 ms / <0.1 MB | ❌ | ❌ |
| Tarjan SCC Layering | 1.2 ms / <0.1 MB | 0.2 ms / <0.1 MB | 24 ms / 7.0 MB | 305 ms / 28 MB | 2.1 s / 255 MB |
| Two-Pass Wire | 0.3 ms / <0.1 MB | <0.1 ms / <0.1 MB | 12 ms / 2.7 MB | 175 ms / <0.1 MB | 1.0 s / 179 MB |

> Times are wall-clock; RAM is heap-delta. All passing results cleared both comparers (smartCompare + flatCompare).

Both Tarjan SCC Layering and Two-Pass Wire successfully hydrate every tier from 10 to 250,000 nodes. Two-Pass Wire completes each tier faster and with lower memory usage. The memory gap grows with scale because Tarjan SCC allocates extra bookkeeping data for every node — to track which component each node belongs to and build the collapsed graph — while Two-Pass Wire allocates only one record per node and nothing else.

The headline result is that cycle-safe graph population is a **solved problem**: both Tarjan SCC Layering and Two-Pass Wire produce correct, fully wired graphs at every scale tested. Either algorithm delivers a complete, accurate in-memory graph — the two differ in resource usage but not in correctness.

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

The memory difference is most pronounced at large scales where Tarjan SCC's extra bookkeeping structures (per-node component tracking arrays, condensation DAG edges) grow alongside the main graph. Two-Pass Wire allocates exactly one record per node plus a single lookup Map and nothing else.

Both algorithms are fast enough for production use at any of the tested scales. The more meaningful distinction is that Tarjan SCC Layering has substantially higher memory overhead at scale — which matters in memory-constrained environments.

---

## §6 — Benchmark Scope

The benchmark targets a **root-reachable, single-root** object graph — the exact closure materialized from one request. Every node in a `core-valid` dataset must be reachable from the root by following dependency edges. The root is auto-detected from graph structure as the unique in-degree-zero node.

Key constraints:
- **Simple directed graph** — at most one directed edge between any ordered pair of nodes.
- **Preflight validation** — all admissibility checks run before any timed execution and have no effect on measured complexity, latency, or memory.
- **`acyclic-control` is a DAG control tier**, not a cyclic benchmark tier.
- Orphaned nodes, dangling references, and duplicate edges are excluded from the core benchmark (classified as `edge-case-only` or `invalid`).

A full input-validity taxonomy is in [`ECOSYSTEM_RESEARCH.md` §6](./ECOSYSTEM_RESEARCH.md#6--dataset-scope-and-input-validity).
