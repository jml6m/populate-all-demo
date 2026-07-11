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

For each framework, we examine three questions:

1. **Cyclic hydration** — can the library fully populate a **cyclic** graph (`A -> B -> A`) from schema alone?
2. **Cyclic serialization** — once such a graph is hydrated in memory, does the library's native serializer work, and if not, what mitigations exist?
3. **Acyclic hydration** — can the library fully populate an **acyclic** graph (`A -> B -> C`) from schema alone?

Conclusions for **cyclic hydration** and **cyclic serialization** are documentation-driven: every surveyed library requires explicit depth/path controls or rejects recursive eager self-relations (so cyclic hydration is assumed to fail for each and is not probed in this project). Every native serializer surveyed lacks a cycle guard (so cyclic serialization fails everywhere absent a mitigation). Conclusions for **acyclic hydration** are tested with custom scripts in this project, the results of which are discussed below. Serialization of the _acyclic_ result is deliberately not the subject of this section — an acyclic tree contains no cycle for a serializer to trip over.

> _Sandbox probes for every framework in this section can be found in [`supporting-probes/`](../supporting-probes/) and can be run locally — see [`Available Commands`](../supporting-probes/README.md#commands)._

### 2.1 — SQLAlchemy (Python)

SQLAlchemy's `Session` maintains an identity map of database IDs to Python objects, so each row is represented by a single instance.[^1] For self-referential relationships, eager loading requires an explicit `join_depth` bound to prevent infinite recursion, as SQL joins do not support unbounded tree structures.[^2] Looking at the write path, it resolves circular foreign keys with `post_update=True`, a two-pass insert-then-link strategy.[^3] No schema-only mechanism fully populates an unbounded cycle. Even if the cyclic object was fully populated in memory, Python's `json.dumps` carries a cycle guard and raises an error the moment it re-encounters a visited node.[^4] Escaping it requires a custom `default=` encoder or an ID-substitution pass that flattens the graph before encoding.

This research probes the `relationship(lazy='selectin')` technique, which fetches a root `a` then walks down the child paths, in this case, triggering two additional queries during traversal.[^5] This results in a `queryGate=FAIL` for our probe because the object does not fully hydrate from the single root fetch.

### 2.2 — Hibernate (Java)

While Hibernate's engine can technically handle infinite depth because it tracks visited nodes in an object via the persistence context, attempting to force full hydration using schema alone would require an infinitely nested SQL join. One workaround is requiring an explicit `join fetch` per layer.[^6] Native/Jackson serialization recurses infinitely on a cycle and throws (`StackOverflowError`); the documented mitigations are annotations such as `@JsonIdentityInfo` and `@JsonBackReference`, whose output is not guaranteed to be supported end-to-end in transport.[^7]

This library does support acyclic hydration, tested in this probe using `@ManyToMany(fetch = EAGER)`: the schema-default fetch returns the full `a -> b -> c` closure and a consumer can then traverse it without triggering any further queries — the probe reports `ACYCLIC_PASS`. This is a "no lazy traversal" pass rather than a single-query fetch, and is treated as **provisional**; [§2.8](#28--limitations-of-the-acyclic-pass-evidence) explains exactly what the pass does and does not establish.

### 2.3 — EF Core (.NET)

EF Core's `ChangeTracker` is an identity map during construction, but complete retrieval across recursive depth requires explicit `.Include().ThenInclude()` chains.[^8] For serialization, `System.Text.Json` throws `JsonException: A possible object cycle was detected` (and separately enforces a depth-64 guard); the documented mitigation is `ReferenceHandler.Preserve`.[^9]

In a slight difference from some of its peers, even for fetching objects with acyclic schemas using `AutoInclude()`, EF Core **rejects this at query-compile time**. The auto-include expansion forms a cycle in the model's include-graph, so it throws `InvalidOperationException` before emitting any SQL or reading a single row. The guard is **data-independent** — it fails identically on an empty table, so EF Core never gets the chance to observe that the actual data (`a -> b -> c`) is acyclic and terminates.

_Note:_ EF Core can hydrate exactly this acyclic closure with an explicit, depth-bounded `.Include().ThenInclude()` — but that is a query-time path declaration, which is not technically schema-driven.

### 2.4 — MikroORM (Node.js)

MikroORM provides no schema-only cyclic full hydration; the wildcard `populate: ['*']` halts at depth 1 on a cyclic self-relation. Even if the cyclic object is fully populated using some other technique, `JSON.stringify` throws `TypeError: Converting circular structure to JSON` when trying to serialize it in a standard way. However, one major achievement for MikroORM is that unlike the other ORMs in this ecosystem research, it does support schema-driven acyclic hydration via `populate: ['*']`.[^10] It materializes the full `a -> b -> c` closure through an identity map with no additional queries **during traversal**, and the acyclic tree serializes cleanly — the probe reports `ACYCLIC_PASS`. As with Hibernate, this is a "no lazy traversal" pass rather than a single-query fetch, and is treated as **provisional** — see [§2.8](#28--limitations-of-the-acyclic-pass-evidence).

### 2.5 — ActiveRecord (Ruby on Rails)

ActiveRecord uses `.includes()` for bounded tree traversal; beyond the explicitly declared depth it silently falls back to lazy loading, firing a burst of N+1 queries to fetch the missing references.[^11] Ruby's native `.to_json` lacks cycle detection, producing a `JSON::NestingError` or a stack overflow on circular references.[^12]

This project probes the ability to populate acyclic graphs in schema-driven fashion using `has_and_belongs_to_many` with no `.includes` (defaults to lazy loading).[^13] Similar to SQLAlchemy, additional queries are made during the traversal, resulting in an N+1 signature which fails the test.

### 2.6 — Other JavaScript ORMs (Mongoose, Sequelize, TypeORM, Prisma)

None of the four exposes a schema-driven recursive hydration method; explicit `.populate(...)` / `include` chains are required. Also, these fail on the native `JSON.stringify` with `TypeError: Converting circular structure to JSON` once a cycle is wired in memory.

For Acyclic hydration, we see two categories emerge here:

- **Under-hydration** (Mongoose,[^14][^15] Sequelize,[^16][^17] Prisma[^19][^20]): the root loads but its relations do not without an explicit `populate` / `include` (same as the cyclic object)
- **Query not constructible** (TypeORM[^18]): the schema-level `eager: true` self-relation expands the self-join without bound and overflows at query construction (`RangeError`), independent of the data.

Only **MikroORM** (see above) reaches full acyclic population among the Node.js libraries.

### 2.7 — The Industry Gap

The foundation for cycle-safe full hydration is nothing new — it is a textbook two-pass pattern with O(V+E) complexity and no corner cases. This research demonstrates that both Tarjan SCC Layering and Two-Pass Wire produce correct, fully wired graphs at every scale from 10 to 250,000 nodes. The problem is solved.

What is striking is that the enterprise ORM ecosystem has, almost without exception, elected not to make this the default. Every library surveyed above requires additional development effort: explicit depth caps in SQLAlchemy (`join_depth`), manual include chains in Hibernate (`join fetch`) and EF Core (`.Include()`), and N+1 fallbacks in some others. The identity map — the very data structure that makes cycle-safe in-memory wiring trivially achievable — is present across these backend ORMs, yet none use it to provide schema-driven full hydration out of the box. Also, we see that many of them do not even support schema-driven _acyclic_ hydration, which is an even bigger shortcoming.

The most important shortcoming is not just cyclic support; several mainstream libraries in this study do not provide schema-driven full hydration even for the acyclic self-referential case, forcing explicit path declarations or lazy-load fallback query bursts.

For a class of tools whose central promise is to abstract away the storage layer, falling short on this important functionality is a significant omission.

### 2.8 — Limitations of the acyclic-pass evidence

The two acyclic **Yes** results (MikroORM, Hibernate) are still treated as **provisional**.

**What the pass actually measures.** `ACYCLIC_PASS` means the schema-default fetch returned a graph that is _fully materialized and traversal-safe_ — a consumer can walk `A -> B -> C` without triggering any further database round-trips. It is **not** a claim that the graph was retrieved in a single SQL query. Neither passing library uses one query: both issue their multi-level loads _during the fetch_ — MikroORM fires a root select plus one batched `IN` select per relation level, and Hibernate's `@ManyToMany(fetch = EAGER)` fires eager sub-selects for the deeper levels. The `queryGate` deliberately measures traversal-time queries only (check occurs after the fetch).

The sandbox probes establish these results at small scale, but a stronger standard is warranted before treating "schema-driven acyclic full hydration is supported" as verified:

- **Query-count instrumentation is traversal-only and library-internal.** The gate counts statements via library hooks — Hibernate's `StatementInspector` and MikroORM's query log — but only over the post-fetch traversal. It therefore verifies the absence of lazy N+1, yet says nothing about how many queries the fetch _itself_ issued, nor whether that count stays bounded (one batched query per level) or degrades toward per-node N+1 as the graph grows. The MikroORM counter was also found to be a no-op unless query logging is explicitly enabled, and even the Hibernate hook observes what the ORM _issues_, not what the database _receives_. A wire-/DB-level inspector that also captures fetch-time query volume would be more authoritative.
- **Scale is unproven.** The probes use a three-node graph. That cannot rule out a hidden depth cap, batching cutoff, or other shortcut that would only surface on a large graph, nor does it characterize the runtime/memory cost that the core experiment measures for the JavaScript algorithms.
- **Documented semantics need confirmation.** Whether `populate: ['*']` and `@ManyToMany(fetch = EAGER)` are _documented_ to fully resolve arbitrary-depth self-referential relations — versus happening to in these versions — should be verified against each library's official docs.

Accordingly, this research is reasonably confident about an acyclic pass for MikroORM and Hibernate. Rigorous at-scale confirmation, as well as external (wire/DB-level) query instrumentation that also counts fetch-time queries, via a large object stress test, and a docs cross-check is tabled for a future release. The cyclic result and the seven acyclic **No** results do not depend on this and stand on their own.

## §3 — Frontend Layer

Unlike the more synchronous nature of backend ORMs, frontend technologies can "get away" with using a different set of hydration strategies because it is a more **event driven** and **declarative** part of the technology stack. Frontend clients (and their caches) can clip a circular graph into a flat, finite tree, and if more data deeper into the cycle is required, the frontend simply triggers a new asynchronous request to the backend. Standard architecture relegates complex calculations and other database interactions to the backend, where issues like data integrity (backend processes often require one single transaction) and database performance ("just-in-time" hydration requires too many small database queries) require the fully hydrated object to be present in memory.

### 3.1 — GraphQL

GraphQL type definitions frequently contain mutual references (e.g., `Author` has `posts`, `Post` has `author`). The standard solution is the **thunk pattern**: wrap the fields in a function called lazily after all types are registered.[^21] This is identical to the two-pass strategy already discussed. Some GraphQL-specific client frameworks, like Apollo `InMemoryCache` and Relay’s `Store`, use a normalized identity map. These require **Global Object Identification**, the mandate that every object has a globally unique `id`.[^22] [^23]

### 3.2 — Traditional Frontend JavaScript Ecosystems

In a traditional decoupled architecture (e.g., a JavaScript-rooted Single Page Application communicating with a REST API), the server is forced to serialize data into generic JSON before transport. Because standard JSON enforces a strict Directed Acyclic Graph (DAG) and crashes on cyclical data, any circular references present on the server are either completely stripped out or manually flattened before reaching the browser.

Once the data arrives on the client, the frontend ecosystem must decide how to reconstruct and manage these data relationships. Broadly, they fall into two paradigms:

#### The Normalized Identity Map Paradigm (The "Flat" State)

> Examples: Redux, Vuex, NgRx.

**Concept:** Abandon memory references entirely. Instead of attempting to reconstruct circular pointers in memory, the client parses the incoming JSON and stores entities purely as a relational Identity Map (a flat dictionary keyed by globally unique IDs). Prioritizes strict immutability, which allows for "Time Travel Debugging", or viewing different snapshots of the data throughout the app's history. This is possible because the data is stored in the frontend as essentially one giant JavaScript object.[^24]<br />
**Trade-off:** Because the state remains completely flat, serialization is trivially solved (no cycles exist). However, the burden of achieving "full population" is pushed to the developer. To render an `Author` and their `Posts`, developers must write explicit selectors to dynamically join these separate dictionary records at runtime.

#### The Referential Graph Paradigm (The "Wired" State)

> Examples: MobX, RxJS, Vue (Reactive).

**Concept:** Fully execute the second pass upon data arrival. The frontend iterates over the incoming flat JSON and manually wires up the true cyclic graph in memory. Allows for more complex frontend JavaScript functionality like Observables and Signals.[^25]<br />
**Trade-off:** Components can safely dot-chain through the hydrated graph (`author.posts[0].author.name`). However, the cyclical serialization problem is immediately reintroduced to the client. If the frontend ever needs to send that state back to the server (or take some actions contained within the frontend itself, like saving it to `localStorage` or inspecting it in DevTools), custom serialization logic is required to flatten the data before crossing a new boundary.

### 3.3 — Full-stack SSR Boundaries and E2E Integrated Transport

Modern full-stack SSR frameworks fundamentally flip this dynamic by explicitly leveraging their **end-to-end framework ownership**. In an ecosystem like the Next.js App Router, the framework authors both the server payload generation and the client hydration cycle. Because of this, they don't have to play by generic JSON's rulebook. When a backend query retrieves a "fully populated" object with a schema containing circular references, the developer can use proprietary wire protocols to send the data to the client component (Headers like `RSC: 1`, `Content-Type: text/x-component`, `Transfer-Encoding: chunked`, etc.)

For example, Next.js utilizes the **React Server Component Payload (RSC)**.[^26] The RSC Payload is a compact, streamable representation of the rendered tree and its associated data. When the React encoder encounters a cyclical object, it does not infinite loop; it tracks object identity and passes a reference pointer (e.g., a chunk ID like `$1`). The client will use HTML to immediately display a quickly rendered "preview" page, while continuously ingesting the RSC Payload stream via one single HTTP request. As suspended data becomes available when a `Promise` finishes, the client-side React runtime merges it into the existing page without a full reload.

There is still some similarity to traditional decoupled paradigms, as the RSC Payload in some ways can be viewed as a distributed identity map. However, the sophistication of these JavaScript libraries allows these data streams to contain more complex content, such as file import metadata and UI template strings (essentially JSON-like representation of HTML components).[^27]

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

[^4]: [Python - json.dump()](https://docs.python.org/3/library/json.html#json.dump)

[^5]: [SQLAlchemy - Relationship Loading Techniques](https://docs.sqlalchemy.org/en/20/orm/queryguide/relationships.html)

[^6]: [Hibernate — Associations](https://docs.hibernate.org/orm/6.6/introduction/html_single/#associations)

[^7]: [Jackson - Bidirectional Relationships and Infinite Recursion](https://www.baeldung.com/jackson-bidirectional-relationships-and-infinite-recursion)

[^8]: [EF Core - Eager Loading](https://learn.microsoft.com/en-us/ef/core/querying/related-data/eager)

[^9]: [EF Core - Serialization](https://learn.microsoft.com/en-us/ef/core/querying/related-data/serialization)

[^10]: [MikroORM - populate: ['\*']](https://mikro-orm.io/docs/populating-relations#populating-all-relations)

[^11]: [ActiveRecord - Eager Loading of Associations](https://api.rubyonrails.org/classes/ActiveRecord/Associations/ClassMethods.html#module-ActiveRecord::Associations::ClassMethods-label-Eager+loading+of+associations)

[^12]: [JavaScript Object Notation - Ruby (JSON)](https://docs.ruby-lang.org/en/3.3/JSON.html)

[^13]: [ActiveRecord - Associations (Rails Guide)](https://guides.rubyonrails.org/v8.0/association_basics.html#has-many-through-vs-has-and-belongs-to-many)

[^14]: [Mongoose — populate](https://mongoosejs.com/docs/populate.html)

[^15]: [Mongoose — issue #16074](https://github.com/Automattic/mongoose/issues/16074)

[^16]: [Sequelize — Eager Loading (including everything)](https://sequelize.org/docs/v6/advanced-association-concepts/eager-loading/#including-everything)

[^17]: [Sequelize — Constraints and Circularities](https://sequelize.org/docs/v6/other-topics/constraints-and-circularities/)

[^18]: [TypeORM — issue #3663](https://github.com/typeorm/typeorm/issues/3663)

[^19]: [Prisma — Relation queries](https://www.prisma.io/docs/orm/prisma-client/queries/relation-queries)

[^20]: [Prisma — issue #3725](https://github.com/prisma/prisma/issues/3725)

[^21]: [GraphQL - Object Types](https://graphql.org/graphql-js/type/#graphqlobjecttype)

[^22]: [Apollo Client — Cache Configuration / Normalization](https://www.apollographql.com/docs/react/caching/cache-configuration/#normalization)

[^23]: [Relay — Object Identification](https://relay.dev/docs/guides/graphql-server-specification/#object-identification)

[^24]: [Redux - Normalizing State Shape](https://redux.js.org/usage/structuring-reducers/normalizing-state-shape)

[^25]: [MobX - Domain Objects](https://mobx.js.org/defining-data-stores.html#domain-objects)

[^26]: [NextJS - Server and Client Components](https://nextjs.org/docs/app/getting-started/server-and-client-components)

[^27]: [NextJS - Suspense](https://nextjs.org/docs/app/api-reference/file-conventions/loading#streaming-with-suspense)
