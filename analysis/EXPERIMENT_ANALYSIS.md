# Cycle-Safe Graph Population in O(V+E): A Two-Pass Solution

This project explores how to fully populate partially hydrated object graphs, showing that cycle-aware graph algorithms can reliably generate self-referential structures without infinite recursion or data loss.

## §1 — Problem Definition: The Need for Deterministic Pointer-to-Object Replacement in Cyclic Graphs

To manage memory and performance, object-relational mappers (ORMs) often utilize **lazy loading** when retrieving complex objects from the database, deferring the load of some data by using placeholders, such as pointers, that only fetch real values when specifically requested. Often there is a need to access the fully constructed object, and while the hydration process is straightforward for Directed Acyclic Graphs (DAGs), the algorithm gets more complex when applied to real-world schemas containing bidirectional or self-referential dependencies.
In the presence of cycles, naive recursive hydration (the most straightforward, unoptimized way to fetch this data) has no safe termination guarantee. Because the traversal follows dependency edges without tracking which nodes it has already wired, cyclic references cause unbounded recursion, which results in stack overflow.

This research proposes a Two-Pass algorithm. By decoupling memory allocation (Pass 1: Vertex Creation) from reference assignment (Pass 2: Edge Wiring), we achieve a cycle-safe solution that operates in $O(V+E)$ time. This approach replaces recursive uncertainty with a deterministic object population algorithm.

## §2 — A Recognized Challenge in the Data Layer Ecosystem

The limitations of current hydration strategies are not unique to a single programming language or library but represent a pervasive challenge in the data-layer ecosystem. For this comparison, we scope the question to **schema-driven full population** in two concrete self-referential cases:

- **Cyclic case:** `A -> B -> A`
- **Acyclic case:** `A -> B -> C`

The table records whether each library can fully populate these graphs from schema/default configuration alone (no explicit per-level path declarations in the query). Cyclic serialization is intentionally out of scope in this section. For raw probe outputs, see the [full results set](../supporting-probes/results/reference/v1/).

The **Acyclic (`A -> B -> C`)** column is verified directly by the sandbox probes. The **Cyclic (`A -> B -> A`)** column is documentation-driven — the probes exercise only the acyclic case, and every surveyed library either requires explicit depth/path controls or rejects recursive eager self-relations outright for the cyclic case.

When testing the broader ORM/ODM landscape for cyclic-reference and recursive-population capabilities, severe functional gaps appear across virtually all major data libraries:

| Library / Ecosystem               | Tested Version                                | Analysis                                                                                                                                                                                                                                                                                                                                                              | Classification          |
| :-------------------------------- | :-------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :---------------------- |
| **Mongoose**<br>_(Node.js)_       | v8.24.0                                       | Cyclic (`A -> B -> A`): **No** — no schema-level recursive wildcard; explicit `.populate(...)` paths are required [[1]](https://mongoosejs.com/docs/populate.html). Acyclic (`A -> B -> C`): **No** — probe fails smartCheck without explicit path chaining.                                                                                                  | **No schema-driven pass** |
| **Sequelize**<br>_(Node.js)_      | v6.37.8                                       | Cyclic (`A -> B -> A`): **No** — self-referential recursive expansion is constrained and requires explicit include structure [[1]](https://sequelize.org/docs/v6/advanced-association-concepts/eager-loading/#including-everything) [[2]](https://sequelize.org/docs/v6/other-topics/constraints-and-circularities/). Acyclic (`A -> B -> C`): **No** — fails smartCheck without explicit include paths. | **No schema-driven pass** |
| **TypeORM**<br>_(Node.js)_        | v0.3.30                                       | Cyclic (`A -> B -> A`): **No** — circular eager self-relations are unsupported/disallowed ([#3663](https://github.com/typeorm/typeorm/issues/3663)). Acyclic (`A -> B -> C`): **No** — the schema-level eager mechanism is not constructible for a self-referential relation: `eager: true` expands the self-join without bound and overflows at query construction (`RangeError`), independent of the data (it fails identically on an empty table).                                                                                   | **No schema-driven pass** |
| **Prisma**<br>_(Node.js)_         | v5.22.0                                       | Cyclic (`A -> B -> A`): **No** — recursive self-relations require explicit nested `include` depth [[1]](https://www.prisma.io/docs/orm/prisma-client/queries/relation-queries) ([#3725](https://github.com/prisma/prisma/issues/3725)). Acyclic (`A -> B -> C`): **No** — fails smartCheck without explicit nested include paths.                       | **No schema-driven pass** |
| **MikroORM**<br>_(Node.js)_       | v6.6.14                                       | Cyclic (`A -> B -> A`): **No** — schema-only cyclic full hydration is not provided [[1]](https://mikro-orm.io/docs/populating-relations#populating-all-relations). Acyclic (`A -> B -> C`): **Yes** — passes hydration + serialization with schema-driven wildcard configuration.                                                                            | **Acyclic-only pass**   |
| **SQLAlchemy**<br>_(Python)_      | v2.0.50                                       | Cyclic (`A -> B -> A`): **No** — self-referential recursion is bounded by explicit loader-depth controls [[1]](https://docs.sqlalchemy.org/en/20/orm/self_referential.html). Acyclic (`A -> B -> C`): **No** — resolves topology but incurs lazy-load traversal queries (`queryGate=FAIL`).                                                                  | **No schema-driven pass** |
| **Hibernate/Jackson**<br>_(Java)_ | v6.6.0.Final (Hibernate)<br>v2.17.0 (Jackson) | Cyclic (`A -> B -> A`): **No** — cyclic full hydration requires explicit per-level fetch shape [[1]](https://docs.hibernate.org/orm/6.6/introduction/html_single/#associations). Acyclic (`A -> B -> C`): **Yes** — passes hydration + serialization using schema-driven eager association defaults.                                                         | **Acyclic-only pass**   |
| **EF Core**<br>_(.NET)_           | v8.0.6                                        | Cyclic (`A -> B -> A`): **No** — cyclic recursive include requires explicit shape [[1]](https://learn.microsoft.com/en-us/ef/core/querying/related-data/eager). Acyclic (`A -> B -> C`): **No** — schema-driven `AutoInclude` on a self-referential navigation is rejected at query compile by the unbounded-include-cycle guard (`InvalidOperationException`), independent of the data (it fails identically on an empty table).                                                  | **No schema-driven pass** |
| **ActiveRecord**<br>_(Ruby)_      | v8.1.3                                        | Cyclic (`A -> B -> A`): **No** — recursive eager loading requires explicit `.includes(...)` depth declarations [[1]](https://api.rubyonrails.org/classes/ActiveRecord/Associations/ClassMethods.html). Acyclic (`A -> B -> C`): **No** — resolves topology but incurs lazy-load traversal queries (`queryGate=FAIL`).                                     | **No schema-driven pass** |

### The three failure modes behind "No"

The eight **No** results are not uniform. The probes separate three distinct ways a library falls short of schema-driven full population, in increasing order of how early it gives up:

1. **Under-hydration** — _Sequelize, Prisma, Mongoose._ The root fetch succeeds, but returns the root with its relations unloaded, so `smartCheck` reports a dependency-closure mismatch. Nothing beyond the root loads without an explicit relation / `populate` / `include`.
2. **Lazy traversal (N+1)** — _SQLAlchemy, ActiveRecord._ The fetch succeeds and the topology is correct, but dependency objects load lazily during traversal, firing an extra query per edge (`queryGate=FAIL`). Full population is reached only by paying round-trips the schema default does not avoid.
3. **Query not constructible** — _TypeORM, EF Core._ The schema-level eager mechanism cannot be compiled for a self-referential relation at all. TypeORM's `eager: true` expands the self-join without bound (`RangeError` at query construction); EF Core's `AutoInclude` is rejected by its unbounded-include-cycle guard (`InvalidOperationException` at query compile). Both fail identically on an empty table, so this is a configuration limit, not a runtime data fault.

Only **MikroORM** (`populate: ['*']`) and **Hibernate** (`@ManyToMany(fetch = EAGER)`) reach full acyclic population from schema defaults. Both materialize rows and resolve associations through an identity map rather than building a single recursive JOIN — which is precisely why they succeed where TypeORM's and EF Core's query-construction step fails.

## §3 — Experiment Design

### Algorithms under test

Four algorithms are benchmarked, representing distinct approaches to the population problem:

| Algorithm               | Approach                       | Core strategy                                                                                                                                                                                                        |
| ----------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Naive Recursion**     | Uncached recursion             | Recursive Depth-First Search (DFS) with no cycle guard and no memoization. Included as the failing control to show what goes wrong without any safeguards.                                                           |
| **Map Tracker**         | Memoized recursion             | Recursive DFS that caches each visited node in a Map so it is never processed twice. Prevents infinite loops but still uses the call stack, which overflows on large graphs.                                         |
| **Tarjan SCC Layering** | Iterative topological ordering | Finds every group of mutually-dependent nodes (Strongly Connected Components), collapses them so the graph has no cycles, then wires dependencies level-by-level using a queue — all steps use loops, not recursion. |
| **Two-Pass Wire**       | Iterative two-pass             | Pass 1 creates every node object and stores it in a lookup Map. Pass 2 wires the dependency edges by looking up the already-created objects. No recursion, no cycle detection needed.                                |

### Dataset tiers

The experiment uses five dataset tiers, generated by `npm run generate` and stored in the [data/](../data/) directory:

| Tier              | Graph type                                                                                               | Scale (nodes) | Purpose                                                                                                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acyclic-control` | DAG where multiple parents can share the same child node (diamond-shaped dependency patterns, no cycles) | ~10           | Acyclic baseline. Hydration succeeds for all algorithms except Naive Recursion, which creates duplicate copies of shared nodes instead of one shared object. Tests memoization correctness independent of cycle handling. |
| `basic`           | Cyclic graph (bidirectional edges, mutual references)                                                    | ~10           | Cyclic baseline. Naive Recursion stack-overflows; the remaining three algorithms hydrate successfully. Establishes the consumer-probe outcome pattern for all larger cyclic tiers.                                        |
| `medium`          | Cyclic graph                                                                                             | ~5K           | Mid-scale correctness and timing check.                                                                                                                                                                                   |
| `stress`          | Cyclic graph                                                                                             | ~50K          | Large-scale test with 50,000 nodes and ~100,000 edges. Exposes Map Tracker's call-stack limit, which is hit on dense graphs even when the cycle guard prevents infinite loops.                                            |
| `extreme`         | Cyclic graph                                                                                             | ~250K         | Maximum-scale test, sized to fill roughly 200–250 MB of heap — within the available memory of a typical developer machine. Confirms the surviving algorithms remain viable at the upper end of the tested range.          |

### Two-stage evaluation

Each algorithm is evaluated in two sequential stages:

**Stage 1 — Hydration:** did the algorithm produce a correct in-memory graph?

Stage 1 uses three independent checks. `HYDRATION PASS` means all three checks passed, even though runtime output intentionally keeps a single pass label:

- **`smartCompare`** — cycle-aware iterative DFS that walks the live object references in the produced graph and compares it node-by-node against the expected answer. No serialization is involved; it navigates JavaScript object references directly.
- **`flatCompare`** — builds an identity map (object → index), converts the produced graph to an index-based representation, and compares it entry-by-entry against the pre-computed answer file. The answer file is the ground truth generated by `npm run generate`; comparing against it is a structural equality check, not a consumer operation.
- **Runtime hydration invariant** — verifies in-memory identity stability and dependency closure on the live object graph (behavioral/runtime trustworthiness), independent of serialization.

Stage 1 checks only in-memory hydration correctness; serialization and downstream consumer viability are still measured separately in Stage 2.

**Stage 2 — Consumer Probes:** can a downstream consumer process the hydrated graph?

Stage 2 runs only when Stage 1 passes. It is a separate measurement of consumer viability, not a correctness criterion — a probe failure means a naive downstream consumer would crash on a correctly hydrated result, not that the algorithm is wrong.

### Consumer probes

Two probes are run against each passing hydration result:

- **`naive-json`** — calls `JSON.stringify` on the raw graph. Succeeds on the `acyclic-control` dataset (no circular references). Fails on all cyclic datasets with a circular reference error. Its purpose is to demonstrate that hydration success does not guarantee consumer viability, mirroring the same serialization gap documented across the ecosystem in [§2](#2--a-recognized-challenge-in-the-data-layer-ecosystem).

- **`cycle-flat`** — converts the graph to an index-based flat representation (the `AnswerEntry` format) using an iterative O(V+E) traversal with no recursion. This mirrors the ID-Substitution / Custom Cycle-Aware Serialization strategies described in [Ecosystem Research §2](./ECOSYSTEM_RESEARCH.md#2--backend-persistence-frameworks). It passes at every graph scale where hydration succeeds.

### Output scope policy

The runner shows full three-phase detail (Hydration → Consumer probes → Full Run) for the `acyclic-control` and `basic` tiers only:

- `acyclic-control` establishes the acyclic baseline (where `naive-json` succeeds and all passing algorithms cleared both comparers).
- `basic` establishes the cyclic baseline (where `naive-json` fails and `cycle-flat` is the authoritative probe).

Larger tiers (`medium`, `stress`, `extreme`) suppress repeated consumer-probe detail because the probe outcome patterns are fully established by these two tiers. Known failures (algorithms that crashed at an earlier cyclic tier) are also omitted from the runs of the larger tiers — they deterministically fail at all scales and re-running adds no information.

## §4 — Results

> **Note on figures:** Timing and RAM measurements below are sourced from the `json` files in [/reports/reference/v1](../reports/reference/v1/).

### Scale Survivability — Stage 1 (Hydration)

| Algorithm           | acyclic-control      | basic             | medium            | stress            | extreme           |
| ------------------- | -------------------- | ----------------- | ----------------- | ----------------- | ----------------- |
| Naive Recursion     | ❌ Identity mismatch | ❌ Stack overflow | ❌ Stack overflow | ❌ Stack overflow | ❌ Stack overflow |
| Map Tracker         | ✅ Pass              | ✅ Pass           | ✅ Pass           | ❌ Stack overflow | ❌ Stack overflow |
| Tarjan SCC Layering | ✅ Pass              | ✅ Pass           | ✅ Pass           | ✅ Pass           | ✅ Pass           |
| Two-Pass Wire       | ✅ Pass              | ✅ Pass           | ✅ Pass           | ✅ Pass           | ✅ Pass           |

**Naive Recursion** fails on every tier. On `acyclic-control`, it fails because of how shared nodes are handled: when node D is a dependency of both node B and node C, the algorithm visits D twice and creates two separate copies of it — so B and C end up pointing to different objects that happen to have the same ID, instead of both pointing to the same single object. The comparers detect this duplication and report a mismatch. On all cyclic datasets, the failure is more severe: populating node A requires populating B (which A depends on), and populating B requires populating A (which B depends on). The algorithm calls itself recursively without end, adding a new level to the function call chain on every step until the program's built-in call limit is exceeded and it crashes.

**Map Tracker** is deceptive: it passes through `acyclic-control`, `basic`, and `medium` before failing at `stress`. Adding a `visited` Map prevents the algorithm from entering an infinite loop — when it encounters a node it has already started processing, it returns the cached result. But this does not reduce how deeply the functions call each other. On a 50,000-node graph, following a chain of previously unvisited nodes can push thousands of nested functions onto the call stack before a cached node is hit. JavaScript enforces a maximum call stack depth, and this limit is exceeded before the algorithm finishes.

**Tarjan SCC Layering** and **Two-Pass Wire** pass all five tiers. Both are fully iterative — no recursion, no call-stack dependency.

### Consumer Probe Results — Stage 2

Consumer probes run only where Stage 1 passed. The pattern is established by the first two tiers:

**acyclic-control (DAG — no cycles):**

| Algorithm           | naive-json | cycle-flat                |
| ------------------- | ---------- | ------------------------- |
| Map Tracker         | ✅ Pass    | ✅ Pass (output verified) |
| Tarjan SCC Layering | ✅ Pass    | ✅ Pass (output verified) |
| Two-Pass Wire       | ✅ Pass    | ✅ Pass (output verified) |

On an acyclic graph, `JSON.stringify` succeeds because there are no circular references. This establishes the acyclic baseline: `naive-json` failures on cyclic tiers are caused by cycles in the hydrated graph, not by algorithmic error.

**basic and all later cyclic tiers (where hydration ✅):**

| Algorithm           | naive-json                  | cycle-flat                |
| ------------------- | --------------------------- | ------------------------- |
| Map Tracker         | ❌ Circular reference error | ✅ Pass (output verified) |
| Tarjan SCC Layering | ❌ Circular reference error | ✅ Pass (output verified) |
| Two-Pass Wire       | ❌ Circular reference error | ✅ Pass (output verified) |

`naive-json` fails uniformly on cyclic datasets because `JSON.stringify` has no cycle guard — it crashes on any graph that contains circular references, regardless of how correctly the algorithm hydrated it. The `cycle-flat` probe passes at every scale, confirming that an iterative index-based approach can safely export the graph at any size.

### Timing and Memory

| Algorithm           | acyclic-control     | basic               | medium                | stress                 | extreme                   |
| ------------------- | ------------------- | ------------------- | --------------------- | ---------------------- | ------------------------- |
| Naive Recursion     | ❌                  | ❌                  | ❌                    | ❌                     | ❌                        |
| Map Tracker         | 0.795 ms / 0.081 MB | 0.199 ms / 0.049 MB | 58.604 ms / 0 MB      | ❌                     | ❌                        |
| Tarjan SCC Layering | 0.899 ms / 0.099 MB | 0.292 ms / 0.064 MB | 38.036 ms / 10.243 MB | 443.007 ms / 52.639 MB | 3,482.344 ms / 281.093 MB |
| Two-Pass Wire       | 0.298 ms / 0.039 MB | 1.088 ms / 0 MB     | 24.678 ms / 0 MB      | 528.237 ms / 37.813 MB | 2,174.188 ms / 203.311 MB |

> **Measurement environment.** Timings and RAM in the table above are sourced from the canonical `v1` benchmark JSONs in [`reports/reference/v1/`](../reports/reference/v1/), measured on GitHub-hosted `ubuntu-latest` with Node 22.22.3 and a 4 GB heap (`NODE_OPTIONS='--max-old-space-size=4096'`). The full release manifest with commit SHA, run ID, and lockfile hashes is at [`reports/reference/v1/manifest.json`](../reports/reference/v1/manifest.json). Local runs on developer hardware will produce different numbers.
>
> _(The Python, Ruby, Java, and .NET runtimes used by supporting probes are recorded in the same manifest but do not affect the JS-only benchmark numbers in the table above.)_

Both Tarjan SCC Layering and Two-Pass Wire successfully hydrate every tier from 10 to 250,000 nodes. At `stress` (50K), Tarjan is faster but uses more RAM; at `extreme` (250K), Two-Pass Wire is faster. The memory gap grows with scale because Tarjan SCC allocates extra bookkeeping structures for the strongly connected components and any additional edges.

The headline result is that cycle-safe graph population is **a solved problem**. Both Tarjan SCC Layering and Two-Pass Wire produce correct, fully wired graphs at every scale tested; either is suitable for production use. Why this hasn't translated into automatic full hydration as an ORM default across the ecosystem is a separate question — see [Ecosystem Research §2](./ECOSYSTEM_RESEARCH.md#2--backend-persistence-frameworks).

## §5 — Scaling Profile

Both surviving algorithms are O(V+E). The analytical proofs are in [Ecosystem Research §1](./ECOSYSTEM_RESEARCH.md#1--the-algorithmic-constraints-of-cyclic-data).

The relative resource trends from the measured results above:

| Metric                | Two-Pass Wire                 | Tarjan SCC Layering       |
| --------------------- | ----------------------------- | ------------------------- |
| 50K → 250K time ratio | 4.1×                          | 7.9×                      |
| 50K → 250K RAM ratio  | 5.4×                          | 5.3×                      |
| Head-to-head at 250K  | **2,174.188 ms / 203.311 MB** | 3,482.344 ms / 281.093 MB |
| Speed advantage       | **~1.6× faster**              | —                         |
| RAM advantage         | **~1.4× less RAM**            | —                         |

The memory difference is most pronounced at large scales where Tarjan SCC's extra bookkeeping structures (per-node component tracking arrays, condensation DAG edges) grow alongside the main graph. Two-Pass Wire allocates exactly one record per node plus a single lookup Map and nothing else.

Both algorithms are fast enough for production use at any of the tested scales. The more meaningful distinction is that Tarjan SCC Layering has substantially higher memory overhead at scale — which matters in memory-constrained environments.

## §6 — Benchmark Scope

The benchmark targets a **root-reachable, single-root** object graph — the exact closure materialized from one request. Every node in a `core-valid` dataset must be reachable from the root by following dependency edges. The root is auto-detected from graph structure as the unique in-degree-zero node.

Key constraints:

- **Simple directed graph** — at most one directed edge between any ordered pair of nodes.
- **Preflight validation** — all admissibility checks run before any timed execution and have no effect on measured complexity, latency, or memory.
- **`acyclic-control` is a DAG control tier**, not a cyclic benchmark tier.
- Orphaned nodes, dangling references, and duplicate edges are excluded from the core benchmark (classified as `edge-case-only` or `invalid`).
