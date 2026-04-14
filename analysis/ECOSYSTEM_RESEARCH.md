# Extended Ecosystem Research: Cyclic Graph Resolution Across the Stack

This document is a companion to [Experiment Analysis](./EXPERIMENT_ANALYSIS.md). It extends the
thesis introduced there — that completeness is a *global* property of a graph — by tracing the
same allocate-then-wire pattern through the full software stack: backend persistence frameworks,
the serialization boundary, GraphQL schema compilation, client-side caches, data-normalization
utilities, state management libraries, and SSR serialization pipelines.

---

## §1 — Completeness as a Global Property

### 1.1 — Local vs. global resolution

Naive depth-first recursion treats graph resolution as a *local* operation: to resolve node u,
call `resolve(u)`, which calls `resolve(v)` for each dependency v, and so on. The assumption
baked into this model is that a node's resolved form depends only on itself and its
already-resolved neighbors. On a DAG that assumption holds — every call terminates because there
are no back-edges. On a cyclic graph it does not. When resolution of u requires resolving v, and
resolving v requires resolving u, neither call can return first, and the recursive call chain
grows without bound until the runtime raises a stack overflow.

The important observation is that this failure is not incidental — it is a direct consequence
of asking a local algorithm to solve a globally constrained problem. A node in a cycle cannot be
fully resolved in isolation because its resolved form legitimately depends on an object that does
not yet exist.

### 1.2 — Completeness as a global invariant

Completeness — the guarantee that every node's dependency list contains real, fully-wired
objects rather than stubs, nulls, or IDs — is a *global* invariant of the graph. It cannot be
satisfied node-by-node in a single pass because satisfying it for node u may require that node v
is already complete, while satisfying it for v may require that u is already complete. The
invariant can only be established over the entire vertex set simultaneously.

A `maxDepth` guard does not solve this: it terminates the traversal but produces a silently
incomplete graph. The invariant is weakened rather than upheld.

### 1.3 — Why the two-pass strategy works

The two-pass O(V+E) strategy succeeds precisely because it decouples *existence* from
*resolution*. Pass 1 (Allocation) establishes the global invariant that every object exists
before any edge is wired:

```
M = { identity(v) : shell(v) | v ∈ V }    — O(V)
```

Every node v is allocated as an empty shell and inserted into the Identity Map M, keyed by its
stable identity (database ID, slug, etc.). After Pass 1, M is a complete directory of the
graph. No node is missing. Pass 2 (Wiring) then resolves every edge in E by a constant-time
lookup in M:

```
∀ e = (u, v) ∈ E : wire(M[identity(u)], M[identity(v)])    — O(E)
```

Because every object already exists in M, `M[identity(v)]` is always a valid reference —
regardless of whether u → v → u is a cycle. The reference is captured correctly; the resulting
in-memory graph has real circular object references, not nulls or IDs.

Total: O(V) + O(E) = **O(V+E)**. No recursion, no cycle detection, no truncation.

The key insight is architectural: by separating *allocation* from *wiring*, the algorithm
converts a problem that requires global knowledge into two sequential passes, each of which only
requires local information.

---

## §2 — Backend Persistence Frameworks

Every major ORM tackles the same cyclic-graph problem the two-pass strategy solves — but at the
database hydration layer. The mechanisms vary by language and framework; the underlying pattern
does not.

### 2.1 — SQLAlchemy (Python)

**Hydration mechanism:** SQLAlchemy's
[Session](https://docs.sqlalchemy.org/en/20/orm/session_basics.html) maintains a per-session
identity map: a dictionary from `(class, primary_key)` tuples to Python objects. When SQLAlchemy
fetches a row, it checks the identity map first. If the object is already present, it returns the
existing Python object rather than creating a new one. This is structurally identical to Pass 1
of the two-pass strategy: every entity has a single canonical object, established before any
relationship traversal.

**Cyclic hydration:** Because the identity map is populated incrementally as rows arrive,
SQLAlchemy can safely hydrate cyclic object graphs during reads. If A references B and B
references A, and both rows are in the result set, SQLAlchemy allocates A's object, allocates
B's object, then wires `A.b = B_object` and `B.a = A_object` — both references resolve to
already-existing Python objects.

**Cyclic insert failure:** Writes are a different story. When SQLAlchemy flushes a transaction
involving mutual foreign key constraints (A.b_id references B, B.a_id references A), it must
emit two `INSERT` statements. Neither can satisfy its FK constraint until the other row exists.
SQLAlchemy detects this and raises
[`CircularDependencyError`](https://docs.sqlalchemy.org/en/21/core/constraints.html#sqlalchemy.schema.ForeignKeyConstraint).

**Resolution — `post_update=True`:** The
[`post_update=True`](https://docs.sqlalchemy.org/en/21/orm/relationship_persistence.html)
flag on a relationship instructs SQLAlchemy to break the circular dependency by deferring one
side of the wiring to a second SQL `UPDATE` after the initial `INSERT`s complete. This is
literally a two-pass insert strategy: allocate rows first (INSERT with NULL FK), then wire the
deferred FK (UPDATE). The analogy to Pass 1 / Pass 2 is exact.

**Documentation links:**
- [Session Basics](https://docs.sqlalchemy.org/en/20/orm/session_basics.html)
- [Relationship Persistence / post_update](https://docs.sqlalchemy.org/en/21/orm/relationship_persistence.html)
- [ForeignKeyConstraint](https://docs.sqlalchemy.org/en/21/core/constraints.html#sqlalchemy.schema.ForeignKeyConstraint)

### 2.2 — Hibernate (Java)

**Hydration mechanism:** Hibernate's Persistence Context (the first-level cache, or L1 cache)
functions as an in-memory identity map. Every entity loaded within an active Session is tracked
by its class and primary key. Subsequent loads of the same entity return the cached Java object
— no duplicate instances. The
[fetching strategies](https://docs.hibernate.org/orm/current/userguide/html_single/#fetching)
documentation covers eager (`JOIN FETCH`, `SELECT` with follow-up queries) and lazy
(proxy-based) loading.

**Cyclic hydration:** Because the Persistence Context holds every entity in memory before
relationships are resolved, Hibernate can safely wire bidirectional associations. Eager fetching
with `JOIN FETCH` loads all associated entities in a single query; the Persistence Context deduplicates
them and wires the Java object graph correctly even when it contains cycles.

**Jackson serialization failure:** Loading a cyclic graph into memory is only half the problem.
Serializing that graph to JSON — the step most REST APIs perform before sending a response —
causes `StackOverflowError` with the default Jackson configuration because Jackson's serializer
follows object references recursively without a cycle guard.

**Mitigations:**

| Annotation | Mechanism | Graph Fidelity |
|---|---|---|
| `@JsonIdentityInfo` | Replaces revisited objects with their ID on subsequent serialization encounters | ✅ Full fidelity — receiver can reconstruct the cycle |
| `@JsonManagedReference` / `@JsonBackReference` | Omits the `@JsonBackReference` side of the relationship entirely | ❌ Data loss — back-reference is dropped |
| `@JsonIgnore` | Omits the annotated field entirely | ❌ Data loss |

`@JsonIdentityInfo` is the only option that preserves graph fidelity. The others trade
correctness for serialization safety — acceptable in some display contexts, but not when the
receiver needs to reconstruct the full graph.

**Documentation links:**
- [Hibernate Fetching strategies](https://docs.hibernate.org/orm/current/userguide/html_single/#fetching)
- [Baeldung: Jackson Infinite Recursion](https://www.baeldung.com/jackson-bidirectional-relationships-and-infinite-recursion)
- [Baeldung: Spring Boot JPA ManyToMany](https://www.baeldung.com/jpa-many-to-many)

### 2.3 — EF Core (.NET)

**Hydration mechanism:** EF Core's `ChangeTracker` acts as the identity map for the current
`DbContext`. Any entity loaded via a tracked query is registered in the `ChangeTracker` by its
primary key. `.Include()` and `.ThenInclude()` perform eager loading; EF Core resolves
navigation properties by matching foreign key values to already-tracked entities — the same
deduplication the two-pass strategy achieves via its Map.

**Cyclic hydration:** EF Core handles in-memory cyclic graphs correctly. Circular navigation
properties (A → B → A) are represented as genuine circular .NET object references.

**`System.Text.Json` serialization failure:** The default .NET JSON serializer throws a
`JsonException` when it encounters a circular reference in a navigation property. The standard
resolution is
[`ReferenceHandler.IgnoreCycles`](https://learn.microsoft.com/en-us/ef/core/querying/related-data/#related-data-and-serialization):

```csharp
services.AddControllers().AddJsonOptions(options =>
{
    options.JsonSerializerOptions.ReferenceHandler = ReferenceHandler.IgnoreCycles;
});
```

This sets looping references to `null` rather than throwing — cycle truncation, not full
fidelity. `Newtonsoft.Json` offers the analogous `ReferenceLoopHandling.Ignore`.

**Documentation links:**
- [EF Core: Related Data and Serialization](https://learn.microsoft.com/en-us/ef/core/querying/related-data/#related-data-and-serialization)
- [EF Core: Lazy Loading without Proxies](https://learn.microsoft.com/en-us/ef/core/querying/related-data/#lazy-loading-without-proxies)

### 2.4 — Node.js ORMs (summary)

The main experiment report covers the Node.js ORM landscape in detail; see
[§2 of EXPERIMENT_ANALYSIS.md](./EXPERIMENT_ANALYSIS.md#2--a-recognized-challenge-in-the-data-layer-ecosystem)
for the full comparison table. The specific mechanisms behind each library's behavior are worth
noting:

| Library | Identity Map? | Cyclic Hydration | Specific Mechanism |
|---|---|---|---|
| **Mongoose** | No | ❌ Stack overflow | Recursive populate with no global node registry; each call site independently resolves the same node |
| **Sequelize** | Partial (within query result) | ❌ Path must be manually pruned | `{ include: { all: true, nested: true } }` generates a recursive include tree; cyclic paths cause infinite query expansion |
| **TypeORM** | Yes (within Unit of Work) | ❌ `eager: true` on both sides disallowed | EntityManager tracks loaded entities, but the eager-loading code path re-enters the same entity without checking the registry |
| **Prisma** | No (immutable result objects) | ❌ Manual depth expansion only | Generated client returns plain JS objects; nested `include` must be written explicitly to each depth — no automatic resolution |
| **MikroORM** | Yes (Identity Map + UoW) | ✅ Hydration safe | Select-in population strategy + identity map; cycles in memory are real JS circular refs — downstream `JSON.stringify` is the failure point |

MikroORM is the closest Node.js ORM to the SQLAlchemy/Hibernate model: its identity map means
cyclic hydration is handled correctly at the ORM layer, but the application developer must still
handle the serialization boundary separately.

---

## §3 — The Serialization Boundary

### 3.1 — Hydration and serialization are distinct problems

It is tempting to treat "handling cyclic data" as a single problem, but it decomposes into two
fundamentally different challenges:

**Hydration** is the process of constructing an in-memory object graph from flat data (database
rows, JSON payloads, YAML files). The inputs are already-deserialized flat records; the output
is a linked graph of objects. Hydration succeeds when every node in the graph holds real object
references — not IDs, not nulls, not stubs — pointing to the correct neighbors. Cyclic graphs
require that all objects exist before any edge is wired, which is why the identity map / two-pass
strategy is necessary.

**Serialization** is the reverse: converting an in-memory object graph into a flat string
representation (JSON, YAML, Protocol Buffers) for transmission, storage, or verification.
Serialization fails on cyclic graphs because standard serializers follow object references
recursively and have no mechanism to detect when they have revisited a node.

These are separate concerns handled at separate layers. An application can successfully hydrate
a cyclic graph and then crash at the serialization step — the ORM did its job correctly, but the
HTTP response layer did not. The distinction matters for diagnosing failures: if `JSON.stringify`
throws on a Hibernate entity, the fix is in the serializer configuration, not in the ORM.

### 3.2 — How this experiment handles the boundary

This experiment relies on serialization to *verify* that hydration succeeded. The verification
pipeline (YAML answer files, `flatCompare`, `smartCompare`) must produce a stable, comparable
representation of the populated graph. This creates a real risk: if the serializer crashes on a
correctly-hydrated cyclic graph, the experiment would report a failure that is actually a
verification artifact rather than an algorithm failure.

The experiment addresses this by using an index-based `AnswerEntry` format rather than
serializing the graph object directly:

```typescript
// AnswerEntry — avoids native JSON.stringify on the cyclic graph
interface AnswerEntry {
  id: string;
  depIndices: number[];   // indices into the flat array, not object references
}
```

By recording the populated graph as an array of entries where each entry references its
dependencies by *index* rather than object reference, the format avoids the circular reference
problem at the verification layer. `flatCompare` and `smartCompare` then compare two such
index-based representations — not two cyclic object graphs — so the verification step is
serialization-safe by construction.

This is a deliberate design decision: the experiment tests the population algorithm, not the
serializer. The `AnswerEntry` format isolates the verification pipeline from any serialization
bug that would otherwise mask a successful hydration.

### 3.3 — Serialization mitigation taxonomy

When cyclic graphs must be serialized to a string format, four broad strategies exist:

| Strategy | Mechanism | Graph Fidelity | Examples |
|---|---|---|---|
| **Cycle Truncation** | Set circular reference to `null` when the serializer revisits a node | ❌ Data loss | `ReferenceHandler.IgnoreCycles` (.NET), `ReferenceLoopHandling.Ignore` (Newtonsoft.Json) |
| **Back-Reference Pruning** | Omit the inverse (back-reference) side of a bidirectional relationship | ❌ Data loss — back-reference unavailable to receiver | `@JsonBackReference` / `@JsonManagedReference` (Jackson) |
| **ID Substitution** | Replace revisited objects with their unique ID; receiver reconstructs the graph | ✅ Full fidelity | `@JsonIdentityInfo` (Jackson), Relay's `__ref` pointers, Apollo `InMemoryCache` |
| **Custom Cycle-Aware Serialization** | Serializer tracks visited objects and emits a non-recursive representation | ✅ Full fidelity | `flatted` npm package, `devalue` (partial — rejects cycles), experiment's `AnswerEntry` format |

The choice of strategy depends on the receiver's needs. If the receiver only needs to display
the data and the back-reference is not displayed, pruning is acceptable. If the receiver must
reconstruct a graph with the same topology — for example, to pass it to another algorithm — only
ID substitution or custom serialization preserves full fidelity.

### 3.4 — Does serialization failure count as experiment failure?

For the purposes of this experiment, no. The experiment measures whether a population algorithm
correctly constructs a cyclic in-memory graph from flat input. The verification harness is
designed to test that property without requiring native `JSON.stringify` on the cyclic result.
A serialization crash in a downstream consumer would not indicate that the algorithm failed.

That said, in a production system, a serialization crash is a crash from the user's perspective,
regardless of which layer caused it. The ORM did not fail, but the API response did not arrive.
The distinction matters for root-cause analysis but not for the end user's experience.

A natural extension of this experiment would add a "serialization tier" to the benchmark:
after the population algorithm runs, attempt to serialize the result using several strategies
(native `JSON.stringify`, `flatted`, index-based, ID substitution) and measure which strategies
survive at each graph scale. This would quantify the serialization problem independently of the
population problem, providing a complete picture of the end-to-end pipeline.

---

## §4 — Frontend and API Layer

The identity-map / allocate-then-wire pattern is not confined to backend ORMs. It surfaces at
every layer where cyclic or heavily-referenced data must be processed — including GraphQL schema
compilation, client-side caches, data normalization libraries, and state management stores.

### §4.1 — GraphQL Schema Compilation

GraphQL type definitions frequently contain mutual references. A canonical example:

```javascript
const AuthorType = new GraphQLObjectType({
  name: 'Author',
  fields: {
    posts: { type: new GraphQLList(PostType) },  // PostType not yet defined
  },
});

const PostType = new GraphQLObjectType({
  name: 'Post',
  fields: {
    author: { type: AuthorType },
  },
});
```

Defining `AuthorType` before `PostType` results in `Output Type but got: undefined` at schema
build time, because `PostType` does not yet exist when `AuthorType`'s fields are evaluated.

The standard solution is the **thunk pattern**: wrap the `fields` property in a function
(a thunk) that is called lazily after all types have been registered:

```javascript
const AuthorType = new GraphQLObjectType({
  name: 'Author',
  fields: () => ({              // ← thunk: deferred until all types exist
    posts: { type: new GraphQLList(PostType) },
  }),
});
```

GraphQL-JS calls each type's field thunk only after the schema object is fully constructed —
that is, after all types have been allocated. This is philosophically identical to the two-pass
strategy: allocate all type objects first, then wire the field references later. The thunk
function plays the role of Pass 2 (Wiring), and the schema construction loop plays the role of
Pass 1 (Allocation).

See the
[GraphQL-JS documentation on circular type references](https://graphql.org/graphql-js/type-system/)
for the canonical description of this pattern.

### §4.2 — GraphQL Client Caches

#### Apollo Client

Apollo's
[`InMemoryCache`](https://www.apollographql.com/docs/react/caching/cache-configuration/#normalization)
normalizes API responses by storing each entity exactly once, keyed by a cache ID (default:
`TypeName:id`). Instead of embedding nested objects directly, the cache stores pointer records:

```json
{
  "Author:1": { "__typename": "Author", "id": "1", "posts": [{ "__ref": "Post:10" }] },
  "Post:10":  { "__typename": "Post",  "id": "10", "author": { "__ref": "Author:1" } }
}
```

The `{ "__ref": "..." }` pointer structurally breaks cycles at the representation layer. The
in-memory store is a flat identity map — every entity appears exactly once — and references
between entities are expressed as ID pointers rather than embedded objects. Reading from the
cache traverses these pointers while tracking visited `__ref` keys to avoid infinite loops.

This means Apollo's cache is internally an identity map in exactly the same sense as SQLAlchemy's
Session or the two-pass strategy's `Map<string, Shell>`. The difference is that Apollo encodes
the references as JSON-serializable `__ref` pointers rather than direct JavaScript object
references, making the cache snapshot naturally serializable.

Unbounded recursive *queries* (e.g., `person { spouse { spouse { spouse { ... } } } }`) are
not handled automatically — the developer must apply `@skip` directives or limit query depth,
because the normalized cache stores data but does not limit what the query requests.

#### Relay

Relay's [`RecordSource`](https://relay.dev/docs/guides/global-object-identification/) implements
a similar normalized cache built around the **Global Object Identification** pattern. Every
queryable entity implements a `Node` interface with a globally unique opaque `id`. Relay's
runtime flattens incoming nested payloads during normalization: each entity at any nesting depth
is written to the `RecordSource` keyed by its global ID. If the same entity appears at two
different paths in the response (a common case in cyclic graphs), both paths resolve to the same
`RecordSource` entry — there is a single source of truth, and all views of that entity are
automatically consistent.

This normalization-on-write approach means Relay's store is always a flat identity map, and
cyclic data is deduplicated by construction.

#### urql

urql provides two caching modes:

1. **Document cache (default):** Stores raw query responses keyed by the query document and
   variables. No normalization is performed. If the response contains cyclic or duplicated
   entities, they are stored as-is, which may produce inconsistent views and does not handle
   cycles in any structured way.

2. **`@urql/exchange-graphcache` (normalized cache):** Implements entity normalization similar
   to Apollo's `InMemoryCache`. Entities are deduplicated by key, and references are stored as
   pointers. Cycles are handled at the same structural level as Apollo.

urql's two modes make it a useful contrast case: normalization is opt-in, and the cycle problem
exists by default in the document cache mode. Developers who do not explicitly enable the
normalized exchange inherit all the problems of an unnormalized store.

### §4.3 — Data Normalization Utilities

#### normalizr

[normalizr](https://github.com/paularmstrong/normalizr) is a standalone library for flattening
nested JSON API responses into normalized entity tables. Given a nested response like:

```json
{
  "id": "1",
  "author": { "id": "10", "name": "Alice" },
  "comments": [{ "id": "100", "author": { "id": "10", "name": "Alice" } }]
}
```

normalizr produces:

```json
{
  "entities": {
    "users":    { "10":  { "id": "10", "name": "Alice" } },
    "articles": { "1":   { "id": "1", "author": "10", "comments": ["100"] } },
    "comments": { "100": { "id": "100", "author": "10" } }
  },
  "result": "1"
}
```

The user entity with id `"10"` is stored once, and all references to it are replaced with its
ID. Cycles are handled by defining schemas using `.define()` for deferred schema resolution —
the library calls the function after all schemas are declared, mirroring the thunk pattern:

```javascript
const user = new schema.Entity('users');
const comment = new schema.Entity('comments', { author: user });
user.define({ friends: [user] });  // ← deferred self-referential definition
```

normalizr directly implements the allocate-then-wire concept for API response processing: the
entity tables are the identity map, and the `.define()` deferral is the mechanism that allows
cyclic schemas to be registered without an initialization-order error.

### §4.4 — State Management Libraries

State management libraries vary significantly in their approach to normalized data, with direct
consequences for cyclic reference handling:

| Library | Framework | Built-in Normalization? | Circular Ref Handling | Serialization Safe? |
|---|---|---|---|---|
| **Redux / RTK** (`createEntityAdapter`) | React | Yes — `{ ids: [], entities: {} }` identity map | Relationships stored as IDs, not object refs | ✅ Yes (ID-based, JSON-serializable) |
| **MobX** | React | No (proxy-based reactivity) | Can hold circular object refs at runtime (observable proxies) | ❌ Serialization crashes without custom `toJS()` handling |
| **Zustand** | React | No (unopinionated flat store) | Manual — must store ID references to avoid object-ref cycles | ❌ Without manual normalization |
| **Pinia** | Vue | No | Manual — same as Zustand | ❌ Without manual normalization |
| **Vuex** | Vue (legacy) | No | Manual | ❌ Without manual normalization |

**Redux / RTK's `createEntityAdapter`** ([docs](https://redux-toolkit.js.org/api/createEntityAdapter))
is worth highlighting because it implements the identity map pattern explicitly, in a form that
every frontend developer already knows. The adapter's state shape:

```typescript
{
  ids: ["1", "2", "3"],          // ordered array of entity IDs
  entities: {                    // dictionary keyed by ID
    "1": { id: "1", ... },
    "2": { id: "2", ... },
    "3": { id: "3", ... },
  }
}
```

is structurally identical to SQLAlchemy's Session, Hibernate's Persistence Context, Apollo's
`InMemoryCache`, and the two-pass strategy's `Map<string, Shell>`. Relationships between
entities are stored as ID references (`authorId: "10"`) rather than embedded objects, so the
store is always serialization-safe and never contains circular object references.

**MobX** is an interesting contrast: its observable proxy model allows a JavaScript object graph
to contain genuine circular references at runtime (because MobX wraps objects in proxies that
track access, not values). Cyclic graphs are handled correctly in memory. However, serializing
a MobX store that contains circular references — for devtools, persistence, or SSR hydration —
requires either `toJS()` with cycle-aware options or manual normalization before serialization.

**Zustand, Pinia, and Vuex** provide no normalization infrastructure. Developers who store
object-reference cycles in these stores will encounter crashes in Redux DevTools, `localStorage`
persistence, or SSR hydration pipelines that attempt to serialize state.

### §4.5 — SSR Serialization Boundaries

Modern SSR frameworks introduce a serialization boundary between the server (where data is
fetched and hydrated) and the client (where it is rehydrated). Data must cross this boundary as
a string, which means cyclic graphs fetched from an ORM on the server will crash the SSR
pipeline if not normalized before serialization.

| Framework | Server→Client Serializer | Handles Cycles? | Error on Circular Data |
|---|---|---|---|
| **Next.js RSC** | React's internal RSC flight protocol | ❌ No | `TypeError: Converting circular structure to JSON` |
| **SvelteKit** | [`devalue`](https://github.com/Rich-Harris/devalue) library | ❌ No (rejects explicitly) | `Cannot stringify object with circular structure` |
| **Nuxt 3** | [`devalue`](https://github.com/Rich-Harris/devalue) library | ❌ No | Same as SvelteKit; `superjson` is not a drop-in replacement |

The [`devalue`](https://github.com/Rich-Harris/devalue) library (by Rich Harris) is used by both
SvelteKit and Nuxt 3. It supports `undefined`, `BigInt`, `Date`, `Map`, `Set`, and `RegExp` —
types that `JSON.stringify` cannot handle — but it explicitly rejects circular structures by
design.

The practical consequence is that any ORM that successfully hydrates a cyclic entity graph on
the server (Hibernate, SQLAlchemy, MikroORM, EF Core) will crash at the SSR serialization step
unless the developer manually strips or normalizes the data before returning it from a `load`
function or React Server Component. The ORM's hydration succeeded; the framework's serializer
did not.

This is the same hydration-vs-serialization boundary identified in §3, manifested at the SSR
layer. The fix is the same: normalize cyclic references to ID pointers before the data crosses
the serialization boundary.

---

## §5 — A Unified Pattern

### 5.1 — The identity map at every layer

The same structural pattern — allocate all objects first, then wire references — appears at
every layer of the stack:

- **Database layer:** SQLAlchemy Session, Hibernate Persistence Context, EF Core ChangeTracker.
  All act as identity maps that ensure one object per entity identity before relationships are
  resolved.
- **ORM population:** Two-Pass Wire. `Map<string, Shell>` is the identity map; Pass 1 fills it,
  Pass 2 wires edges.
- **API schema compilation:** GraphQL-JS thunks defer field wiring until all type objects are
  allocated in the schema registry.
- **Client cache:** Apollo `InMemoryCache`, Relay `RecordSource`. Normalized flat stores keyed
  by entity ID; references expressed as `__ref` pointers rather than embedded objects.
- **Client state:** Redux `createEntityAdapter`. `{ ids, entities }` is the identity map;
  relationships stored as ID strings.
- **Normalization utilities:** normalizr. Entity tables are the identity map; `.define()`
  defers self-referential schema wiring.

The implementations differ in language, API, and context, but the invariant they enforce is
identical: at the point where edges are wired, every target object already exists in the map.

### 5.2 — Cyclic data cannot be processed locally at any layer

The common failure mode — naive DFS recursion — appears in some form at every layer:

- Naive ORM `populate()` (Mongoose)
- Recursive Jackson serialization without `@JsonIdentityInfo`
- `JSON.stringify` without a seen-set
- GraphQL type definition without field thunks
- unnormalized urql document cache
- MobX or Zustand stores with object-ref cycles hitting devtools serialization

In every case, the failure is caused by a local algorithm attempting to resolve a reference to
an object that has not yet been allocated, or attempting to serialize a structure whose
serialization depends recursively on itself. The two-pass strategy is the general resolution to
this class of failure, not an ORM-specific fix.

### 5.3 — The pattern across layers

| Layer | Technology | Identity Map Implementation | Cycle Resolution |
|---|---|---|---|
| Database ORM | SQLAlchemy | Session | Automatic via identity map + `post_update=True` for inserts |
| Database ORM | Hibernate | Persistence Context (L1 cache) | Automatic via L1 cache; serialization requires `@JsonIdentityInfo` |
| Database ORM | EF Core | ChangeTracker | Automatic via identity map; serialization requires `ReferenceHandler.IgnoreCycles` |
| Database ORM | MikroORM | Identity Map + Unit of Work | Hydration automatic; serialization is the failure point |
| Population Algorithm | Two-Pass Wire | `Map<string, Shell>` | Allocate-then-wire — O(V+E), zero truncation |
| GraphQL Schema | GraphQL-JS | Schema type registry + thunks | Allocate types first, wire fields via deferred thunk |
| GraphQL Client | Apollo Client | `InMemoryCache` (`__ref` pointers) | Normalized by cache ID; pointers break object-ref cycles |
| GraphQL Client | Relay | `RecordSource` | Global Object Identification — flatten to ID-keyed store |
| GraphQL Client | urql (normalized) | `@urql/exchange-graphcache` | Normalized cache, same model as Apollo |
| State Management | Redux / RTK | `createEntityAdapter` | `{ ids, entities }` identity map; relationships as ID strings |
| Normalization | normalizr | Entity tables | Flatten nested JSON + ID-substitute; `.define()` for deferred wiring |

### 5.4 — Conclusion

Cyclic data is not a pathological edge case. It is the natural state of any domain with
bidirectional relationships — entity graphs, org charts, component systems, social graphs.
The two-pass strategy is not a clever trick specific to ORM population; it is a general
graph resolution primitive that every layer of the modern web stack independently rediscovers.

Understanding the pattern at a structural level — identity map + deferred wiring — allows
developers to recognize the same problem and apply the same solution regardless of the layer
where the cycle appears: ORM hydration, GraphQL schema construction, client cache normalization,
or state management design.

---

## §6 — Dataset Scope and Input Validity

### Motivating model

The experiment is grounded in the NodeJS/NoSQL hydration scenario: a backend receives a
request, selects **one root node**, fetches the reachable object graph from the database,
and must fully hydrate — populating every referenced dependency as a real in-memory object —
before passing the result to a downstream consumer (API serializer, cache writer, view
renderer, etc.).

This model has three defining properties:

1. **Root-reachable closure.** Every node in the materialized graph is reachable from the
   selected root by following dependency edges. Nodes that are not reachable from the root
   were simply not part of the query result — they are absent, not orphaned.
2. **Identity preservation.** Nodes shared by multiple parents must be represented as a
   single in-memory object instance, not independent copies. This is what the Two-Pass Wire
   strategy guarantees and what Naive Recursion violates.
3. **Two-stage pipeline.** Hydration correctness (Stage 1) and consumer/serialization
   viability (Stage 2) are architecturally distinct. The benchmark measures both; the
   distinction matters for understanding which failures belong to the algorithm and which
   belong to the downstream consumer.

### Input validity taxonomy

The table below classifies graph types against the motivating model and assigns each a
benchmark status.

| Graph type | Status | Rationale |
| --- | --- | --- |
| **Root-reachable cyclic graphs** (mutual cycles, back-edges, self-loops reachable from root) | ✅ Core benchmark | Directly models the real-world hydration problem; `basic`, `medium`, `stress`, `extreme` tiers |
| **Root-reachable DAGs with shared references** (`acyclic-control`) | ✅ Core benchmark | Exposes identity-mismatch failures (Naive Recursion) in the absence of cycles; required to separate cycle failures from memoization failures |
| **SCC-heavy / dense mutual-cycle graphs** | ✅ Core benchmark | Stress-tests the condensation and wiring phases; realistic for deeply inter-referenced domain models |
| **Realistic fan-out / fan-in patterns** | ✅ Core benchmark | Common in NoSQL embedded-reference schemas (one parent, many children; many parents, one shared child) |
| **Orphaned nodes / disconnected subgraphs** | 🔲 Edge-case suite only | Not part of a root-selected materialization; see §6.1 for full reasoning |
| **Multi-root forests** (intentional batch materializations) | 🔲 Edge-case suite only | May model a batch hydration request; meaningful only if the experiment extends to multi-document scenarios |
| **Duplicate edges** | 🔲 Edge-case suite only | Possible in hand-crafted or malformed manifests; worth validating parser/generator, but not a realistic backend output |
| **Missing-target (dangling) references** | ❌ Invalid — reject | An edge pointing to a node that does not exist is invalid input, not a topology variant; must be rejected before benchmarking |
| **Corrupt or unparseable manifests** | ❌ Invalid — reject | Infrastructure/tooling concern, not an algorithm topology |

### §6.1 — Orphaned nodes: why they are excluded from the core benchmark

An *orphaned node* is a node that exists in the input dataset but is not reachable from the
root via dependency edges — a disconnected component that floats alongside the main graph.

**Why they are not valid core-benchmark inputs:**

In the motivating NodeJS/NoSQL scenario, the input dataset represents exactly one
materialized request boundary: the set of entities the backend fetched and needs to wire up.
If a node is present in that set, it was fetched — and therefore it was reachable from the
root selection. A node that is unreachable from the root would not appear in the fetch result
in the first place. Orphaned nodes are not a topology that arises naturally from a
well-functioning backend; they are either a generator artifact or a signal of malformed data.

Including orphaned nodes in the canonical benchmark would:

- mis-represent the algorithm's input domain (real fetch results are root-reachable closures),
- conflate hydration correctness with parser/loader robustness, and
- make graph-scale metrics (V, E) misleading because some nodes carry no algorithmic weight.

**Why they remain useful as edge-case tests:**

Even though orphaned nodes are out-of-scope for the canonical benchmark, they are a valid
and important *validation* target:

- **Parser/loader robustness** — does the input loader correctly handle a manifest that
  accidentally includes unreferenced nodes?
- **Consumer/export robustness** — does the export strategy (`cycle-flat`) correctly traverse
  only the reachable subgraph, or does it inadvertently include orphaned nodes in the output?
- **Generator validation** — does the dataset generator produce only root-reachable nodes, or
  can a configuration error produce disconnected components?

These scenarios belong in a **dedicated edge-case test suite**, kept separate from the main
benchmark tiers, with their own expected outputs and explicit documentation of what is being
tested.

### §6.2 — Dangling references: invalid input, not a topology

A *dangling reference* is an edge (u → v) where v does not exist in the input dataset. This
is categorically different from an orphaned node. An orphaned node is a valid graph element
that happens to be unreachable; a dangling reference points to a node that is absent
entirely.

Dangling references are **invalid input** and must be rejected. In the current
implementations, this rejection already happens at algorithm time: `twoPassWire` throws when
a dependency id is missing, and `tarjanSccLayering` likewise pre-validates dependencies and
throws rather than silently producing `undefined` or a corrupted condensation DAG. Such
inputs are therefore not meaningful benchmark data points.

The experiment runner's manifest validator should still detect missing-target edges earlier
and abort with a clear, input-focused error. That remains an input-sanitization concern, even
though the algorithms themselves also reject the invalid graph today.

---

## References

1. **SQLAlchemy — Session Basics**
   https://docs.sqlalchemy.org/en/20/orm/session_basics.html

2. **SQLAlchemy — Relationship Persistence / `post_update`**
   https://docs.sqlalchemy.org/en/21/orm/relationship_persistence.html

3. **SQLAlchemy — ForeignKeyConstraint**
   https://docs.sqlalchemy.org/en/21/core/constraints.html#sqlalchemy.schema.ForeignKeyConstraint

4. **SQLAlchemy — MetaData / `create_all`**
   https://docs.sqlalchemy.org/en/20/core/metadata.html

5. **Hibernate — Fetching Strategies**
   https://docs.hibernate.org/orm/current/userguide/html_single/#fetching

6. **Baeldung — Jackson: Bidirectional Relationships and Infinite Recursion**
   https://www.baeldung.com/jackson-bidirectional-relationships-and-infinite-recursion

7. **Baeldung — Spring Boot: JPA ManyToMany**
   https://www.baeldung.com/jpa-many-to-many

8. **EF Core — Related Data and Serialization**
   https://learn.microsoft.com/en-us/ef/core/querying/related-data/#related-data-and-serialization

9. **EF Core — Lazy Loading without Proxies**
   https://learn.microsoft.com/en-us/ef/core/querying/related-data/#lazy-loading-without-proxies

10. **Apollo Client — Cache Configuration / Normalization**
    https://www.apollographql.com/docs/react/caching/cache-configuration/#normalization

11. **Relay — Global Object Identification**
    https://relay.dev/docs/guides/global-object-identification/

12. **urql — `@urql/exchange-graphcache`**
    https://urql.dev/goto/docs/graphcache/

13. **normalizr — GitHub Repository**
    https://github.com/paularmstrong/normalizr

14. **Redux Toolkit — `createEntityAdapter`**
    https://redux-toolkit.js.org/api/createEntityAdapter

15. **devalue — GitHub Repository**
    https://github.com/Rich-Harris/devalue

16. **GraphQL-JS — Type System (circular type references / thunk pattern)**
    https://graphql.org/graphql-js/type-system/

17. **Mongoose — Issue #16074 (circular reference / populate stack overflow)**
    https://github.com/Automattic/mongoose/issues/16074

18. **Sequelize — Constraints and Circularities**
    https://sequelize.org/docs/v6/other-topics/constraints-and-circularities/

19. **TypeORM — Issue #3663 (eager: true on recursive relation causes infinite loop)**
    https://github.com/typeorm/typeorm/issues/3663

20. **MikroORM — Populating Relations**
    https://mikro-orm.io/docs/populating-relations

21. **Prisma — Self-relations**
    https://www.prisma.io/docs/orm/prisma-schema/data-model/relations/self-relations
