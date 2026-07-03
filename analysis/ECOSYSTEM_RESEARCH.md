# Extended Ecosystem Research: A Comparative Study of Graph Hydration and Serialization

While our core experiment demonstrates a viable approach to cyclic graph hydration in JavaScript, this extended research takes a deeper dive into how the broader ecosystem handles these challenges. Specifically, we explore two distinct but deeply intertwined problems: the _schema-driven full hydration_ problem (fully populating an object with circular references) and the _serialization_ problem (converting that hydrated object into an acceptable format). By examining a variety of technology stacks, we aim to understand how different libraries attempt to bridge the gap between relational data stores and properly constructed object representations.

---

## §1 — The Algorithmic Constraints of Cyclic Data

### 1.1 — Why naive recursion fails on cyclic graphs

A naive recursive hydrator assumes dependencies eventually terminate. In a cycle (`u -> v -> u`), that assumption is false: resolving `u` requires `v`, and resolving `v` immediately requires `u` again. Without a global identity map, recursion does not converge and eventually overflows the call stack. Completeness—the guarantee that every node's dependency list contains real, fully-wired objects rather than stubs, nulls, or IDs—cannot be satisfied in a single pass.

### 1.2 — The two-pass necessity in linear time

To safely hydrate a cyclic graph, an algorithm must process every vertex and every edge exactly once, resulting in a time complexity of `O(V+E)`.

Pass 1 (Allocation) establishes the global invariant that every object exists before any edge is wired. Every node is allocated as an empty shell and inserted into an Identity Map `M`:

$$
M = \{ \text{id}(v) \mapsto \text{alloc}(v) \mid v \in V \}
$$

After Pass 1, `M` is a complete directory of the graph. Pass 2 (Wiring) then resolves every edge by a constant-time lookup:

$$
\forall (u, v) \in E: M[u].\text{edge} = M[v]
$$

Because every object already exists in `M`, the target is always a valid reference—regardless of whether `u -> v -> u` is a cycle.

---

## §2 — Backend Persistence Frameworks

For this report revision, backend comparison is scoped to two schema-driven hydration questions only:

1. Can the library fully populate a **cyclic** self-referential graph from schema/default configuration alone (`A -> B -> A`)?
2. Can the library fully populate an **acyclic** self-referential graph from schema/default configuration alone (`A -> B -> C`)?

Query-level explicit depth/path declarations are out of scope for this section.

Probe versions for the current published reference set are recorded per-probe in [`supporting-probes/results/reference/v1/`](../supporting-probes/results/reference/v1/) (each `<probe>.json` carries its `libraryVersion` field).

> _Sandbox probes for every framework in this section live in [`supporting-probes/`](../supporting-probes/) and can be run locally — see [`supporting-probes/README.md#commands`](../supporting-probes/README.md#commands) for prerequisites and usage._

Conclusions for the cyclic case are documentation-driven in this patch cycle: all surveyed libraries require explicit depth/path controls or reject recursive eager self-relations. Conclusions for the acyclic case are backed by sandbox probes; canonical published snapshots under `supporting-probes/results/reference/v<N>/` are written only by the release workflow.

### 2.1 — SQLAlchemy (Python)

SQLAlchemy's `Session` maintains an identity map, but schema-only unbounded recursive hydration is not provided for self-referential relationships; depth controls remain explicit (`join_depth`, loader options).[^1] [^2] In the acyclic-case probe, topology is reachable, but traversal still triggers additional lazy-load queries (`queryGate=FAIL`), so it does not satisfy full schema-driven population under this project's definition.

### 2.2 — Hibernate (Java) and EF Core (.NET)

Hibernate's Persistence Context and EF Core's `ChangeTracker` are both identity maps, but they diverge under schema-driven rules. Hibernate passes the acyclic case with eager association defaults in the probe: it materializes rows and resolves associations through the persistence context rather than emitting one recursive JOIN. EF Core's schema-driven `AutoInclude` on a self-referential navigation is instead rejected at query-compile time by its unbounded-include-cycle guard (`InvalidOperationException`) — a configuration limit independent of the data (it fails identically on an empty table), not a runtime fault — so the acyclic case fails in probe output.[^4] [^5]

### 2.3 — MikroORM (Node.js)

MikroORM remains "No" for schema-driven cyclic full hydration in the cyclic case, but it is one of the two libraries that passes the schema-driven acyclic probe under this definition (hydration + serialization pass).

### 2.4 — ActiveRecord (Ruby on Rails)

ActiveRecord requires explicit `.includes(...)` depth for eager recursion and therefore does not satisfy schema-driven cyclic full hydration.[^8] In the acyclic case, it resolves topology but relies on additional lazy-load queries during traversal (`queryGate=FAIL`), so it is also "No" for schema-driven acyclic full hydration in this project's strict sense.

### 2.5 — JavaScript ORMs

For the detailed JavaScript ORM comparison matrix, see [`EXPERIMENT_ANALYSIS.md`](./EXPERIMENT_ANALYSIS.md).[^10] In the updated acyclic-case probes, only MikroORM passes schema-driven acyclic full hydration. Sequelize, Prisma, and Mongoose under-hydrate — the root loads but its relations do not, failing `smartCheck` — whereas TypeORM fails one step earlier: its `eager: true` self-relation query is not even constructible, overflowing at query construction (`RangeError`) independent of the data.

### 2.6 — The Industry Gap

The updated evidence reinforces a narrower but clearer industry gap:

- **Schema-driven cyclic full hydration (`A -> B -> A`)** is unsupported across all surveyed libraries.
- **Schema-driven acyclic full hydration (`A -> B -> C`)** is supported only by a minority in this probe set (MikroORM and Hibernate).

The most important shortcoming is not just cyclic support; several mainstream libraries in this study do not provide schema-driven full hydration even for the acyclic self-referential case, forcing explicit path declarations or lazy-load fallback query bursts.

Among the libraries that fall short, the shortfall takes three distinct forms, in increasing order of how early the library gives up:

- **Under-hydration** (Sequelize, Prisma, Mongoose): the root loads but its relations do not, absent an explicit `populate` / `include`.
- **Lazy traversal / N+1** (SQLAlchemy, ActiveRecord): the topology resolves, but only by firing a query per edge during traversal.
- **Query not constructible** (TypeORM, EF Core): the schema-level eager mechanism cannot be compiled for a self-referential relation at all — it fails at query construction, independent of the data.

Only MikroORM and Hibernate materialize the full acyclic closure from schema defaults, resolving associations through an identity map rather than a single recursive JOIN.

---

## §3 — Frontend Layer

Unlike the more synchronous nature of backend ORMs, frontend technologies can "get away" with using a different set of hydration strategies because it is a more **event driven** and **declarative** part of the technology stack. Frontend clients (and their caches) can clip a circular graph into a flat, finite tree, and if more data deeper into the cycle is required, the frontend simply triggers a new asynchronous request to the backend. Standard architecture relegates complex calculations and other database interactions to the backend, where issues like data integrity (backend processes often require one single transaction) and database performance ("just-in-time" hydration requires too many small database queries) require the fully hydrated object to be present in memory.

### 3.1 — GraphQL

GraphQL type definitions frequently contain mutual references (e.g., `Author` has `posts`, `Post` has `author`). The standard solution is the **thunk pattern**: wrap the fields in a function called lazily after all types are registered.[^11] This is identical to the two-pass strategy already discussed. Some GraphQL-specific client frameworks, like Apollo `InMemoryCache` and Relay’s `Store`, use a normalized identity map. These require **Global Object Identification**, the mandate that every object has a globally unique `id`.[^12] [^13]

### 3.2 — Traditional Frontend JavaScript Ecosystems

In a traditional decoupled architecture (e.g., a JavaScript-rooted Single Page Application communicating with a REST API), the server is forced to serialize data into generic JSON before transport. Because standard JSON enforces a strict Directed Acyclic Graph (DAG) and crashes on cyclical data, any circular references present on the server are either completely stripped out or manually flattened before reaching the browser.

Once the data arrives on the client, the frontend ecosystem must decide how to reconstruct and manage these data relationships. Broadly, they fall into two paradigms:

#### The Normalized Identity Map Paradigm (The "Flat" State)

> Examples: Redux, Vuex, NgRx.

**Concept:** Abandon memory references entirely. Instead of attempting to reconstruct circular pointers in memory, the client parses the incoming JSON and stores entities purely as a relational Identity Map (a flat dictionary keyed by globally unique IDs). Prioritizes strict immutability, which allows for "Time Travel Debugging", or viewing different snapshots of the data throughout the app's history. This is possible because the data is stored in the frontend as essentially one giant JavaScript object.[^14]<br />
**Trade-off:** Because the state remains completely flat, serialization is trivially solved (no cycles exist). However, the burden of achieving "full population" is pushed to the developer. To render an `Author` and their `Posts`, developers must write explicit selectors to dynamically join these separate dictionary records at runtime.

#### The Referential Graph Paradigm (The "Wired" State)

> Examples: MobX, RxJS, Vue (Reactive).

**Concept:** Fully execute the second pass upon data arrival. The frontend iterates over the incoming flat JSON and manually wires up the true cyclic graph in memory. Allows for more complex frontend JavaScript functionality like Observables and Signals.[^15]<br />
**Trade-off:** Components can safely dot-chain through the hydrated graph (`author.posts[0].author.name`). However, the cyclical serialization problem is immediately reintroduced to the client. If the frontend ever needs to send that state back to the server (or take some actions contained within the frontend itself, like saving it to `localStorage` or inspecting it in DevTools), custom serialization logic is required to flatten the data before crossing a new boundary.

### 3.3 — Full-stack SSR Boundaries and E2E Integrated Transport

Modern full-stack SSR frameworks fundamentally flip this dynamic by explicitly leveraging their **end-to-end framework ownership**. In an ecosystem like the Next.js App Router, the framework authors both the server payload generation and the client hydration cycle. Because of this, they don't have to play by generic JSON's rulebook. When a backend query retrieves a "fully populated" object with a schema containing circular references, the developer can use proprietary wire protocols to send the data to the client component (Headers like `RSC: 1`, `Content-Type: text/x-component`, `Transfer-Encoding: chunked`, etc.)

For example, Next.js utilizes the **React Server Component Payload (RSC)**.[^16] The RSC Payload is a compact, streamable representation of the rendered tree and its associated data. When the React encoder encounters a cyclical object, it does not infinite loop; it tracks object identity and passes a reference pointer (e.g., a chunk ID like `$1`). The client will use HTML to immediately display a quickly rendered "preview" page, while continuously ingesting the RSC Payload stream via one single HTTP request. As suspended data becomes available when a `Promise` finishes, the client-side React runtime merges it into the existing page without a full reload.

There is still some similarity to traditional decoupled paradigms, as the RSC Payload in some ways can be viewed as a distributed identity map. However, the sophistication of these JavaScript libraries allows these data streams to contain more complex content, such as file import metadata and UI template strings (essentially JSON-like representation of HTML components).[^17]

---

## §4 — Algorithmic Theory: The Two-Pass Necessity

### The Scenario: The Simplest Circular Graph

Imagine the simplest possible circular graph containing two objects: **Object A** and **Object B**.

- `A` has a property that points to `B`.
- `B` has a property that points to `A`.

> IMPORTANT: To completely construct and hydrate an object in memory, any dependency it points to **must already exist**. You cannot create a hard reference to an object that has not yet been allocated by the system.

#### 1. The Mathematical Proof (Chronological Paradox)

Let’s assign a mathematical variable to the exact moment in time an object is created.

- Let `T(A)` = The time Object A is created.
- Let `T(B)` = The time Object B is created.

Because Object A requires Object B to exist before A can be created, A's creation time must be strictly greater (later in time) than B's:

> `T(A) > T(B)`

Because Object B requires Object A to exist before B can be created, B's creation time must be strictly greater than A's:

> `T(B) > T(A)`

By applying the transitive property of inequality (if A > B and B > C, then A > C) to combine these two rules, we arrive at a chronological paradox:

> `T(A) > T(A)`

**The Contradiction:** A number cannot be strictly greater than itself. Therefore, a single-pass hydration of a circular dependency is mathematically impossible. From a hardware (physical) perspective, you are asking the compiler to reference something before it has been created.

#### 2. How a Two-Pass Solution Solves the Math

A two-pass solution resolves the paradox by splitting the single time variable `T` into two distinct phases:

1. `T_allocate` (allocating the empty object in memory)
2. `T_link` (attaching the references)

#### Pass 1 (Allocation)

`T_allocate(A)` and `T_allocate(B)` occur. Both empty objects now exist in memory. They have addresses, but no linked properties.

#### Pass 2 (Hydration)

`T_link(A)` and `T_link(B)` occur. Because Pass 1 entirely completed before Pass 2 began, we establish a new mathematical truth:

- `T_allocate(B) < T_link(A)` _(B's memory exists before A points to it)_
- `T_allocate(A) < T_link(B)` _(A's memory exists before B points to it)_

#### Conclusion

By separating memory allocation from reference assignment, the chronological paradox is broken. Both references point to memory addresses that were safely established in the past.

---

## Appendix A — Methodological Boundaries

This extended report is scoped to cross-ecosystem comparison of full cyclic hydration and post-hydration serialization. It relies on the motivating model defined in the core experiment. To maintain clear boundaries, this analysis assumes:

1. **Root-reachable closure:** Every node in the materialized graph is reachable from a selected root. Orphaned (disconnected) nodes are out-of-scope for the core algorithm comparison, as they do not naturally arise in a schema-driven relational fetch.
2. **Single-object materialization:** Dependencies reached from multiple parents must resolve to one coherent in-memory node in the fully populated graph, not duplicated copies.
3. **Valid edges:** "Dangling" references (edges pointing to nodes that do not exist) are invalid input, not a topology variant, and are rejected at preflight.

---

## References

[^1]: [SQLAlchemy — Session Basics](https://docs.sqlalchemy.org/en/20/orm/session_basics.html)

[^2]: [SQLAlchemy — Self-Referential Strategies](https://docs.sqlalchemy.org/en/20/orm/self_referential.html)

[^4]: [Hibernate — Associations](https://docs.hibernate.org/orm/6.6/introduction/html_single/#associations)

[^5]: [EF Core - Eager Loading](https://learn.microsoft.com/en-us/ef/core/querying/related-data/eager)

[^8]: [ActiveRecord - Eager Loading of Associations](https://api.rubyonrails.org/classes/ActiveRecord/Associations/ClassMethods.html#module-ActiveRecord::Associations::ClassMethods-label-Eager+loading+of+associations)

[^10]: [EXPERIMENT_ANALYSIS §2](./EXPERIMENT_ANALYSIS.md#2--a-recognized-challenge-in-the-data-layer-ecosystem)

[^11]: [GraphQL - Object Types](https://graphql.org/graphql-js/type/#graphqlobjecttype)

[^12]: [Apollo Client — Cache Configuration / Normalization](https://www.apollographql.com/docs/react/caching/cache-configuration/#normalization)

[^13]: [Relay — Object Identification](https://relay.dev/docs/guides/graphql-server-specification/#object-identification)

[^14]: [Redux - Normalizing State Shape](https://redux.js.org/usage/structuring-reducers/normalizing-state-shape)

[^15]: [MobX - Domain Objects](https://mobx.js.org/defining-data-stores.html#domain-objects)

[^16]: [NextJS - Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components)

[^17]: [NextJS - Suspense](https://nextjs.org/docs/app/api-reference/file-conventions/loading#streaming-with-suspense)
