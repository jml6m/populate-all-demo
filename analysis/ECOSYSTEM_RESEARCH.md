# Extended Ecosystem Research: A Comparative Study of Graph Hydration and Serialization

While our core experiment demonstrates a viable approach to cyclic graph hydration in JavaScript, this extended research takes a deeper dive into how the broader ecosystem handles these challenges. Specifically, we explore two distinct but deeply intertwined problems: the *schema-driven full hydration* problem (querying and reconstructing a complete, cyclic relational graph in memory) and the *serialization* problem (converting that hydrated, cyclic object into an acceptable format for transport). By examining a variety of technology stacks—from backend persistence frameworks to frontend state managers—we aim to understand how different languages and libraries attempt to bridge the gap between relational data stores and memory-safe graph representations.

---

## §1 — The Algorithmic Constraints of Cyclic Data

### 1.1 — Why naive recursion fails on cyclic graphs

A naive recursive hydrator assumes dependencies eventually terminate. In a cycle (`u -> v -> u`), that assumption is false: resolving `u` requires `v`, and resolving `v` immediately requires `u` again. Without a global identity map, recursion does not converge and eventually overflows the call stack.

### 1.2 — Why `maxDepth` guards also fail

A depth cap prevents infinite recursion, but it does so by truncating part of the graph. That means the algorithm returns an incomplete object model (missing edges or placeholders) rather than a fully hydrated cyclic graph. For schema-driven *full* hydration, depth caps are a safety stop, not a correctness solution.

### 1.3 — Why `O(V+E)` is the right target

To safely hydrate a cyclic graph, an algorithm must process every vertex (entity) and every edge (relationship) exactly once—resulting in a time complexity of `O(V+E)`.

Pass 1 allocates a shell for each vertex and stores it in an identity map:

$$
M[id(v)] = allocate(v) \quad \forall v \in V
$$

Pass 2 links relationships using constant-time identity-map lookups:

$$
M[id(u)].edge = M[id(v)] \quad \forall (u, v) \in E
$$

Using this two-pass structure guarantees that forward references in cycles are resolvable when edges are wired.

---

## §2 — The Serialization Boundary

### 2.1 — Why standard serializers fail after successful hydration

Hydration and serialization are different stages. A framework can correctly construct a cyclic in-memory graph and still fail when exporting it. Standard `JSON.stringify` performs recursive traversal and throws on circular references (`TypeError: Converting circular structure to JSON`) instead of preserving graph topology.

### 2.2 — Typical serializer outcomes in cyclic graphs

When serializers encounter revisited objects, common outcomes are:

- hard failure (exception),
- branch dropping / omission,
- replacement with `null` or metadata wrappers,
- or a reference-aware custom format.

These outcomes are transport-format decisions, not hydration-correctness decisions.

### 2.3 — Practical mitigation patterns

| Pattern | Cycle handling approach | Typical fidelity profile |
| --- | --- | --- |
| Cycle truncation | Drops revisited links (often `null`) | Partial graph / data loss |
| Back-reference pruning | Omits one side of a bidirectional relation | Partial graph / directional loss |
| Reference-tracking | Emits IDs or references (`$ref`, `__ref`) | Potentially full topology if consumer reconstructs |
| Custom non-JSON serializers | Uses specialized output format and parser | Depends on implementation and receiver support |
| Hypermedia-style links (for example HAL-like) | Sends linkable resource identities instead of full embedded cycles | Trades object fidelity for transport stability |

In practice, reference-tracking formats, purpose-built serializers (including tools like `devalue`), and link-oriented API representations are the most common viable approaches in real systems; each is a trade-off based on consumer expectations rather than a universal winner.

### 2.4 — Why this experiment chose index-based serialization

The experiment intentionally avoids raw cyclic object serialization in its comparison path. It uses an index-based `AnswerEntry` representation so verification can evaluate hydration correctness without conflating failures from downstream serializers. This keeps Stage 1 focused on graph construction while still allowing Stage 2 consumer probes to evaluate transport constraints in isolation.

---

## §3 — Backend Persistence Frameworks

### 3.1 — SQLAlchemy

SQLAlchemy's `Session` functions as an identity map keyed by entity identity, which enables coherent in-memory cyclic references once entities are loaded [1]. For self-referential eager loading, SQLAlchemy also documents explicit depth controls such as `join_depth` [2], showing the practical gap between identity-map hydration capability and unbounded schema-driven expansion. On write paths with mutual foreign keys, `post_update=True` is the documented deferred-link workaround [3].

### 3.2 — Hibernate and EF Core

Hibernate's Persistence Context and EF Core's `ChangeTracker` both provide identity-map behavior during entity materialization [4][5]. That helps avoid duplicate in-memory instances, but it does **not** automatically solve full "populate all" retrieval across arbitrary recursive depth: query shape, eager-loading configuration, and N+1 avoidance are still application responsibilities [4][5][6].

Likewise, serialization annotations/options (`@JsonIdentityInfo`, `@JsonBackReference`, `ReferenceHandler.*`) are mitigation tools, not complete out-of-the-box guarantees for end-to-end full-fidelity graph transport [6][7].

### 3.3 — .NET and other mature stacks (high-level)

Across .NET, Java, Python, and Ruby ecosystems, a recurring pattern appears: ORM identity maps can stabilize in-memory graph identity, but API serialization layers often apply separate constraints or defaults that require explicit configuration to avoid cycle-related failures [3][6][7][8].

### 3.4 — JavaScript ORMs (summary + pointer)

For the detailed JavaScript ORM comparison matrix (Mongoose, Sequelize, TypeORM, Prisma, MikroORM), see `EXPERIMENT_ANALYSIS.md §2` [9].

At a high level, the common failure themes are: explicit manual-depth query authoring, wildcard depth ceilings, eager-loading restrictions in recursive relationships, and frequent dependence on application-layer post-processing when full cyclic reconstruction is needed.

---

## §4 — Frontend and API Layer

Frontend and API research matters here because hydrated data is ultimately *consumed* in clients and app-state stores. Even when backend hydration succeeds, deserialization, cache normalization, and client-state serialization boundaries can still reject or degrade cyclic structures.

### 4.1 — GraphQL client caches (Apollo and Relay)

Apollo `InMemoryCache` normalizes records by `__typename` + entity ID and stores references via `__ref`, flattening nested payloads into a normalized identity map [10]. Relay similarly maintains a normalized record store with global IDs and garbage collection semantics in its runtime store [11].

Both patterns demonstrate that robust client handling of cyclic/graph-like data typically relies on normalized reference indirection, not naive nested object trees.

### 4.2 — normalizr as evidence of the problem

`normalizr` requires developers to explicitly define entity schemas and replace embedded objects with IDs in normalized output [12]. This is useful evidence that generic nested payloads do not automatically become safe, reusable graph state without deliberate normalization rules.

### 4.3 — State management comparison (React / Vue / Angular)

| Framework ecosystem | Typical reactivity model | Cyclic graph support in state | Practical implication |
| --- | --- | --- | --- |
| React (Redux Toolkit, MobX, Zustand) | Immutable updates (Redux) and/or proxy/subscription models | Supported in memory, but safest when normalized as ID-linked entities | Normalization patterns are usually required for reliable persistence, devtools, and transport |
| Vue (Pinia / Vuex) | Proxy-based reactivity over plain objects | Runtime cycles are possible, but toolchain/serialization boundaries still need explicit handling | Teams commonly model relationships by IDs to avoid serializer/tooling surprises |
| Angular (NgRx, Signals + services) | RxJS/store patterns and signal-driven reactive state | Similar constraints: runtime can hold references, transport/devtools often prefer normalized entities | Entity-style stores reduce risk and improve predictable updates |

Across all three ecosystems, cycle tolerance at runtime does not remove the need for deliberate normalization at storage and transport boundaries.

### 4.4 — Full-stack SSR boundaries and `devalue`

SSR frameworks frequently control their own server-to-client payload protocol, so they are not always limited to plain JSON. Next.js and SvelteKit/Nuxt-style pipelines can use framework-specific serialization contracts; in that sense, the boundary is partially proprietary to the stack's runtime.

`devalue` is a key example: it supports several non-JSON-native types but intentionally rejects circular object graphs [13]. That design illustrates the core boundary clearly: even with framework-controlled serialization, cyclic hydrated objects still require normalization or reference-safe transformations before crossing SSR handoff boundaries.

---

## §5 — Algorithmic Theory: The Two-Pass Necessity

Can full hydration be done in one pass? Sometimes:

- **Yes for DAGs:** a topological order can guarantee dependencies are created before dependents.
- **No for arbitrary cyclic graphs:** forward references are unavoidable when `u` and `v` depend on each other.

Without two passes (or an equivalent mechanism like pointers/thunks/placeholders that are later resolved), a single-pass algorithm cannot guarantee full cyclic reconstruction with correct object identity for all inputs. Two-pass allocation-then-linking is therefore a general solution pattern, not just an implementation preference.

---

## Appendix A — Methodological Boundaries

This extended report is scoped to cross-ecosystem comparison of two concerns: full cyclic hydration and post-hydration serialization.

- It assumes valid graph inputs for comparative analysis (well-formed identities and link targets).
- It focuses on architectural behavior patterns, not exhaustive vendor feature catalogs.
- Detailed benchmark-tier mechanics and dataset-specific validation policies remain in `EXPERIMENT_ANALYSIS.md` and project runner documentation [9][14].

---

## References

[1]: https://docs.sqlalchemy.org/en/20/orm/session_basics.html
[2]: https://docs.sqlalchemy.org/en/20/orm/self_referential.html
[3]: https://docs.sqlalchemy.org/en/20/orm/relationship_persistence.html
[4]: https://docs.hibernate.org/orm/6.6/introduction/html_single/#associations
[5]: https://learn.microsoft.com/en-us/ef/core/querying/related-data/eager
[6]: https://www.baeldung.com/jackson-bidirectional-relationships-and-infinite-recursion
[7]: https://learn.microsoft.com/en-us/ef/core/querying/related-data/serialization
[8]: https://api.rubyonrails.org/classes/ActiveRecord/Associations/ClassMethods.html
[9]: ./EXPERIMENT_ANALYSIS.md#2--a-recognized-challenge-in-the-data-layer-ecosystem
[10]: https://www.apollographql.com/docs/react/caching/cache-configuration/#normalization
[11]: https://relay.dev/docs/guided-tour/reusing-cached-data/fetch-policies/
[12]: https://github.com/paularmstrong/normalizr
[13]: https://github.com/sveltejs/devalue
[14]: ../README.md
