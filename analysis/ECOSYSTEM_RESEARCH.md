# Extended Ecosystem Research: A Comparative Study of Graph Hydration and Serialization

While our core experiment demonstrates a viable approach to cyclic graph hydration in JavaScript, this extended research takes a deeper dive into how the broader ecosystem handles these challenges. Specifically, we explore two distinct but deeply intertwined problems: the _schema-driven full hydration_ problem (fully populating an object with circular references) and the _serialization_ problem (converting that hydrated object into an acceptable format). By examining a variety of technology stacks, we aim to understand how different libraries attempt to bridge the gap between relational data stores and properly constructed object representations.

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

## §2 — Backend Persistence Frameworks

It is tempting to treat "handling cyclic data" as a single problem, but it decomposes into two fundamentally different challenges. An application can successfully _hydrate_ a cyclic graph in memory, and then crash at the _serialization_ step when standard functions like `JSON.stringify` encounter the circular reference. The ORM did its job correctly, but converting it into a standard industry format for shared use requires additional effort.

For each framework below, we examine three questions in turn:

1. **Cyclic hydration** — can the library fully populate a **cyclic** self-referential graph (`A -> B -> A`) from schema/default configuration alone?
2. **Cyclic serialization** — once such a graph is hydrated in memory, does the library's native serializer survive the cycle, and what mitigations exist?
3. **Acyclic hydration** — can the library fully populate an **acyclic** self-referential graph (`A -> B -> C`) from schema alone?

Conclusions for **cyclic hydration** and **cyclic serialization** are documentation-driven: every surveyed library requires explicit depth/path controls or rejects recursive eager self-relations (so cyclic hydration is assumed to fail everywhere and is not probed), and every native serializer surveyed lacks a cycle guard (so cyclic serialization fails everywhere absent a mitigation). Conclusions for **acyclic hydration** are backed by the sandbox probes, with the schema-default strategy exercised for each library named inline. Serialization of the _acyclic_ result is deliberately not the subject of this section — an acyclic tree contains no cycle for a serializer to trip over.

> _Sandbox probes for every framework in this section live in [`supporting-probes/`](../supporting-probes/) and can be run locally — see [`supporting-probes/README.md#commands`](../supporting-probes/README.md#commands) for prerequisites and usage._

### 2.1 — SQLAlchemy (Python)

**Cyclic hydration.** SQLAlchemy's `Session` maintains an identity map of database IDs to Python objects, so each row is represented by a single instance.[^1] For self-referential relationships, however, eager loading requires an explicit `join_depth` bound to prevent infinite recursion, as SQL joins do not express unbounded tree structures.[^2] The write path resolves circular foreign keys with `post_update=True`, a two-pass insert-then-link strategy.[^3] No schema-only mechanism fully populates an unbounded cycle. **No.**

**Cyclic serialization.** Python's `json.dumps` carries a cycle guard and raises `ValueError: Circular reference detected` the moment it re-encounters a node. Escaping it requires a custom `default=` encoder or an ID-substitution pass that flattens the graph before encoding.

**Acyclic hydration.** The schema default probed is `relationship(lazy='selectin')`. Fetching root `a` and then walking `a -> b -> c` triggers **two additional queries** during traversal (`queryGate=FAIL`) — the N+1 signature: the topology resolves, but the closure is not materialized from the single root fetch. **No.** _(The precise `selectin` recursion semantics for a self-referential many-to-many are flagged for at-scale follow-up in [§2.9](#29--limitations-of-the-acyclic-pass-evidence).)_

### 2.2 — Hibernate (Java)

**Cyclic hydration.** Hibernate's Persistence Context functions as an identity map during object construction, avoiding duplicate in-memory instances, but it does **not** automatically retrieve arbitrary recursive depth: complete retrieval requires an explicit `join fetch` per level.[^4] **No.**

**Cyclic serialization.** Native/Jackson serialization recurses infinitely on a cycle and throws (`StackOverflowError`); the documented mitigations are annotations such as `@JsonIdentityInfo` and `@JsonBackReference`, whose output is not guaranteed to round-trip end-to-end in transport.[^7]

**Acyclic hydration.** The schema default probed is `@ManyToMany(fetch = EAGER)`. It materializes the full `a -> b -> c` closure through the Persistence Context identity map with no additional traversal queries, and the acyclic result serializes cleanly — the probe reports `ACYCLIC_PASS`. **Yes**, treated as **provisional** pending at-scale confirmation ([§2.9](#29--limitations-of-the-acyclic-pass-evidence)).

### 2.3 — EF Core (.NET)

**Cyclic hydration.** EF Core's `ChangeTracker` is an identity map during construction, but complete retrieval across recursive depth requires explicit `.Include().ThenInclude()` chains.[^5] **No.**

**Cyclic serialization.** `System.Text.Json` throws `JsonException: A possible object cycle was detected` (and separately enforces a depth-64 guard); the documented mitigation is `ReferenceHandler.Preserve`.[^6]

**Acyclic hydration.** The schema default probed is model-level `AutoInclude()` on the self-referential `Dependencies` navigation. EF Core **rejects this at query-compile time**: the auto-include expansion forms a cycle in the model's include-graph, so it throws `InvalidOperationException` before emitting any SQL or reading a single row. The guard is **data-independent** — it fails identically on an empty table, so EF Core never gets the chance to observe that the actual data (`a -> b -> c`) is acyclic and terminates. **No**, by query-non-constructibility. _Nuance:_ EF Core **can** hydrate exactly this acyclic closure with an explicit, depth-bounded `.Include().ThenInclude()` — but that is a query-time path declaration, which the schema-driven ("no query-time include paths") definition used here deliberately excludes.

### 2.4 — MikroORM (Node.js)

**Cyclic hydration.** MikroORM provides no schema-only cyclic full hydration; the wildcard `populate: ['*']` halts at depth 1 on a cyclic self-relation. **No.**

**Cyclic serialization.** Once MikroORM's identity map wires the cycle back together, `JSON.stringify` throws `TypeError: Converting circular structure to JSON`.

**Acyclic hydration.** The schema default probed is `populate: ['*']`. It materializes the full `a -> b -> c` closure through MikroORM's identity map with no additional queries, and the acyclic tree serializes cleanly — the probe reports `ACYCLIC_PASS`. **Yes**, treated as **provisional** pending at-scale confirmation ([§2.9](#29--limitations-of-the-acyclic-pass-evidence)).

### 2.5 — ActiveRecord (Ruby on Rails)

**Cyclic hydration.** ActiveRecord uses `.includes()` for bounded tree traversal; beyond the explicitly declared depth it silently falls back to lazy loading, firing a burst of N+1 queries to fetch the missing references.[^8] **No.**

**Cyclic serialization.** Ruby's native `.to_json` lacks cycle detection, producing a `JSON::NestingError` or a stack overflow on circular references.[^9]

**Acyclic hydration.** The schema default probed is `has_and_belongs_to_many` with no `.includes` (lazy). Walking `a -> b -> c` fires **two lazy queries** during traversal (`queryGate=FAIL`) — the same N+1 signature as SQLAlchemy: the topology resolves, but not from the root fetch. **No.**

### 2.6 — JavaScript ORMs (Mongoose, Sequelize, TypeORM, Prisma)

The detailed matrix and per-library tested versions live in [`EXPERIMENT_ANALYSIS.md`](./EXPERIMENT_ANALYSIS.md).[^10]

**Cyclic hydration.** None of the four exposes a schema-level recursive wildcard; explicit `.populate(...)` / `include` chains are required. **No** across the board.

**Cyclic serialization.** Each fails native `JSON.stringify` with `TypeError: Converting circular structure to JSON` once a cycle is wired in memory.

**Acyclic hydration.** All **No**, in two distinct forms:

- **Under-hydration** (Mongoose, Sequelize, Prisma): the root loads but its relations do not without an explicit `populate` / `include`, so `smartCheck` reports a dependency-closure mismatch at the root `a`.
- **Query not constructible** (TypeORM): the schema-level `eager: true` self-relation expands the self-join without bound and overflows at query construction (`RangeError`), independent of the data.

Only **MikroORM** ([§2.4](#24--mikroorm-nodejs)) reaches full acyclic population among the Node.js libraries.

### 2.7 — The Industry Gap

The foundation for cycle-safe full hydration is nothing new — it is a textbook two-pass pattern with O(V+E) complexity and no corner cases. This research demonstrates that both Tarjan SCC Layering and Two-Pass Wire produce correct, fully wired graphs at every scale from 10 to 250,000 nodes. The problem is solved.

What is striking is that the enterprise ORM ecosystem has, almost without exception, elected not to make this the default. Every library surveyed above offloads the _cyclic_ case to the developer: explicit depth caps in SQLAlchemy (`join_depth`), manual include chains in Hibernate (`join fetch`) and EF Core (`.Include()`), and N+1 fallbacks in ActiveRecord. The identity map — the very data structure that makes cycle-safe in-memory wiring trivially achievable — is present across these backend ORMs, yet none exposes it as _automatic unbounded cyclic_ hydration out of the box (the two libraries that do reach full **acyclic** population from schema defaults, Hibernate and MikroORM, still stop short of the cyclic case).

The gap between what is algorithmically possible and what ships as an ORM default is a deliberate product decision — and across virtually every library in this survey, that decision has consistently landed on the conservative side. Cycle-safe full hydration remains solved at the theory layer and absent at the defaults layer. For a class of tools whose central promise is to abstract away the storage layer, not supporting unbounded cyclic graph population is a significant omission.

### 2.8 — Even for Acyclic Objects

The updated evidence reinforces a narrower but clearer industry gap:

- **Schema-driven cyclic full hydration (`A -> B -> A`)** is unsupported across all surveyed libraries.
- **Schema-driven acyclic full hydration (`A -> B -> C`)** is supported only by a minority in this probe set (MikroORM and Hibernate).

The most important shortcoming is not just cyclic support; several mainstream libraries in this study do not provide schema-driven full hydration even for the acyclic self-referential case, forcing explicit path declarations or lazy-load fallback query bursts.

Among the libraries that fall short, the shortfall takes three distinct forms, in increasing order of how early the library gives up:

- **Under-hydration** (Sequelize, Prisma, Mongoose): the root loads but its relations do not, absent an explicit `populate` / `include`.
- **Lazy traversal / N+1** (SQLAlchemy, ActiveRecord): the topology resolves, but only by firing a query per edge during traversal.
- **Query not constructible** (TypeORM, EF Core): the schema-level eager mechanism cannot be compiled for a self-referential relation at all — it fails at query construction, independent of the data.

Only MikroORM and Hibernate materialize the full acyclic closure from schema defaults, resolving associations through an identity map rather than a single recursive JOIN.

### 2.9 — Limitations of the acyclic-pass evidence

The two acyclic **Yes** results (MikroORM, Hibernate) are the least-settled findings in this report and are treated as **provisional**. The sandbox probes establish them at small scale, but a stronger standard is warranted before treating "schema-driven acyclic full hydration is supported" as settled:

- **In-memory population is well-supported.** `smartCheck` walks live object references and would fault on an uninitialized collection (MikroORM's `getItems()` throws) or a detached association (Hibernate, traversed after the session closes, throws `LazyInitializationException`). A `smartCheck` pass is therefore strong, instrumentation-independent evidence that the fetch materialized the full `A -> B -> C` closure — at the tested scale.
- **Query-count instrumentation is weaker and library-internal.** The N+1 gate counts statements via library hooks — Hibernate's `StatementInspector` (authoritative: fires for every statement, with the second-level cache disabled) and MikroORM's query log. The MikroORM counter was found to be a no-op unless query logging is explicitly enabled, and even the Hibernate hook observes what the ORM _issues_, not what the database _receives_. A wire-/DB-level inspector would be more authoritative.
- **Scale is unproven.** The probes use a three-node graph. That cannot rule out a hidden depth cap, batching cutoff, or other shortcut that would only surface on a large graph, nor does it characterize the runtime/memory cost that the core experiment measures for the JavaScript algorithms.
- **Documented semantics need confirmation.** Whether `populate: ['*']` and `@ManyToMany(fetch = EAGER)` are _documented_ to fully resolve arbitrary-depth self-referential relations — versus happening to in these versions — should be verified against each library's official docs.

Accordingly, the acyclic **Yes** for MikroORM and Hibernate should be read as "supported at small scale in these probe versions," with a rigorous at-scale confirmation (external query instrumentation, a runtime/memory stress test, and a docs cross-check) left to follow-up work tracked in [issue #88](https://github.com/jml6m/populate-all-demo/issues/88). The cyclic result and the seven acyclic **No** results do not depend on this and stand on their own.

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

## Appendix A — Methodological Boundaries

This extended report is scoped to cross-ecosystem comparison of full cyclic hydration and post-hydration serialization. It relies on the motivating model defined in the core experiment. To maintain clear boundaries, this analysis assumes:

1. **Root-reachable closure:** Every node in the materialized graph is reachable from a selected root. Orphaned (disconnected) nodes are out-of-scope for the core algorithm comparison, as they do not naturally arise in a schema-driven relational fetch.
2. **Single-object materialization:** Dependencies reached from multiple parents must resolve to one coherent in-memory node in the fully populated graph, not duplicated copies.
3. **Valid edges:** "Dangling" references (edges pointing to nodes that do not exist) are invalid input, not a topology variant, and are rejected at preflight.

## References

[^1]: [SQLAlchemy — Session Basics](https://docs.sqlalchemy.org/en/20/orm/session_basics.html)

[^2]: [SQLAlchemy — Self-Referential Strategies](https://docs.sqlalchemy.org/en/20/orm/self_referential.html)

[^3]: [SQLAlchemy — Relationship Persistence / `post_update`](https://docs.sqlalchemy.org/en/20/orm/relationship_persistence.html)

[^4]: [Hibernate — Associations](https://docs.hibernate.org/orm/6.6/introduction/html_single/#associations)

[^5]: [EF Core - Eager Loading](https://learn.microsoft.com/en-us/ef/core/querying/related-data/eager)

[^6]: [EF Core - Serialization](https://learn.microsoft.com/en-us/ef/core/querying/related-data/serialization)

[^7]: [Jackson - Bidirectional Relationships and Infinite Recursion](https://www.baeldung.com/jackson-bidirectional-relationships-and-infinite-recursion)

[^8]: [ActiveRecord - Eager Loading of Associations](https://api.rubyonrails.org/classes/ActiveRecord/Associations/ClassMethods.html#module-ActiveRecord::Associations::ClassMethods-label-Eager+loading+of+associations)

[^9]: [JavaScript Object Notation (JSON)](https://docs.ruby-lang.org/en/3.3/JSON.html)

[^10]: [EXPERIMENT_ANALYSIS §2](./EXPERIMENT_ANALYSIS.md#2--a-recognized-challenge-in-the-data-layer-ecosystem)

[^11]: [GraphQL - Object Types](https://graphql.org/graphql-js/type/#graphqlobjecttype)

[^12]: [Apollo Client — Cache Configuration / Normalization](https://www.apollographql.com/docs/react/caching/cache-configuration/#normalization)

[^13]: [Relay — Object Identification](https://relay.dev/docs/guides/graphql-server-specification/#object-identification)

[^14]: [Redux - Normalizing State Shape](https://redux.js.org/usage/structuring-reducers/normalizing-state-shape)

[^15]: [MobX - Domain Objects](https://mobx.js.org/defining-data-stores.html#domain-objects)

[^16]: [NextJS - Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components)

[^17]: [NextJS - Suspense](https://nextjs.org/docs/app/api-reference/file-conventions/loading#streaming-with-suspense)
