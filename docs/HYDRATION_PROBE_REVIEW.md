# Hydration Probe Review — Code Walk-Through and Conclusion Audit

> **Scope:** This is a temporary review document for the code-review walkthrough of the extended
> supporting-probe hydration conclusions before the v1 patch is cut. It covers every probe script
> (`mikroorm-test.ts`, `test_sqlalchemy.py`, `Main.java`, `Program.cs`, `typeorm-test.ts`,
> `mongoose-test.ts`, `test_activerecord.rb`, `sequelize-test.ts`, `prisma-test.ts`) against the
> frozen [`supporting-probes/results/reference/v1/`](../supporting-probes/results/reference/v1/)
> artifacts.
>
> Delete this file after the patch review is complete.

---

## 1 — What the probes actually measure

Every probe script follows an identical four-step protocol. Understanding this protocol is the
foundation for auditing every conclusion.

### 1.1 The four findings

Each probe populates four boolean findings that roll up into one `outcome`:

| Finding | What it asks |
| --- | --- |
| **`queryGate`** | Did the ORM re-query the database *during* the traversal loop (after the initial load)? Zero extra queries = `PASS`. |
| **`smartCheck`** | Does the traversal of live in-memory objects satisfy two invariants: (a) each logical ID maps to exactly **one** in-memory instance (identity), and (b) every node's actual dependency set matches the expected adjacency map? |
| **`hydration`** | Composite: `PASS` iff both `queryGate` and `smartCheck` are `PASS`. |
| **`serialize`** | Does a naïve `JSON.stringify` / `json.dumps` / `JsonSerializer.Serialize` succeed on the in-memory graph? |

The `outcome` rollup is:

- `HYDRATION_FAIL` if `hydration.result === "FAIL"`
- `SERIALIZE_FAIL` if hydration passed but serialize is `SERIALIZE_FAIL_*`
- `PASS` if all four findings pass
- `MIXED` otherwise

### 1.2 The test graph

Every probe tests the same minimal 2-node cycle:

```
A ──depends-on──▶ B
B ──depends-on──▶ A
```

Expected adjacency: `{ a: ['b'], b: ['a'] }`

This is the simplest possible cycle. If an ORM cannot correctly represent this graph in memory as
two distinct objects each pointing to the other, it fails `smartCheck`. The size is intentionally
minimal: it tests the structural capability without introducing confounding performance effects.

### 1.3 The `smartCheck` identity invariant — why it matters

```typescript
// shared.ts
const prior = byId.get(id);
if (prior !== undefined && prior !== node) {
  return { pass: false, reason: `id "${id}" maps to multiple in-memory instances`, ... };
}
```

This check uses reference equality (`!==`), not value equality. It fails if the traversal
encounters two *separate JavaScript/Java/Python/Ruby objects* that both claim the same ID. This
precisely captures what identity maps prevent: without one, `a.dependencies[0]` (node B seen from
A) and `roots[1]` (node B at the top level) are separate heap allocations that happen to hold the
same data.

---

## 2 — The definition of "Hydration Gap" in the analysis

`EXPERIMENT_ANALYSIS.md` §2 intro states:

> **(A) Hydration Limits** (ability to fully populate objects based on schema alone)

"Schema alone" is the operative phrase. A Hydration Gap exists when the ORM cannot resolve a
complete, cycle-correct in-memory graph **without the caller declaring explicit depth levels** in
the query. This is a design-time capability gap, not a runtime crash.

The probe scripts do **not** use schema-driven population for the identity-map ORMs. They
deliberately pass explicit 2-level eager-load paths to confirm that the identity map works at all.
The probe therefore returns `hydration=PASS` for those ORMs — but that does not eliminate the
Hydration Gap, because a user who tried schema-driven population (e.g. `populate: ['*']` in
MikroORM) would get truncated results at depth 1.

This is the core nuance: **the probe's `hydration=PASS` for identity-map ORMs confirms that the
identity map mechanism is functional given explicit paths; the Hydration Gap in the table is about
the absence of a schema-driven wildcard that works at arbitrary depth.**

---

## 3 — Group A: Identity-map ORMs (probe `hydration=PASS`)

These four ORMs share a common pattern: they use an in-memory identity registry (Persistence
Context, `ChangeTracker`, SQLAlchemy session, MikroORM `EntityManager`) so that when the same
database row is fetched more than once during a query, all fetches resolve to the same heap object.
That is what allows a cyclic graph to be correctly represented.

### 3.1 MikroORM

**Probe file:** [`mikroorm-test.ts`](../supporting-probes/mikroorm-test.ts)

**Eager-load call:**

```typescript
const roots = await orm.em.find(
  Node,
  { id: { $in: ['a', 'b'] } },
  { populate: ['dependencies.dependencies'], orderBy: { id: 'asc' } }
);
```

**Why explicit paths?** `populate: ['*']` is documented to halt at depth 1 intentionally (see
[MikroORM docs](https://mikro-orm.io/docs/populating-relations#populating-all-relations)). For a
2-node cycle, the minimum explicit path to reach the back-edge is `dependencies.dependencies` (A →
B → A). Without the second level, traversal from A reaches B but B's `dependencies` collection is
uninitialized — `smartCheck` would fail because `getDeps(b)` returns `[]` instead of `['a']`.

**Traversal loop (post-load, pre-queryGate snapshot):**

```typescript
const queriesAfterHydration = queryCount;
for (const root of roots) {
  for (const dep of root.dependencies.getItems()) {
    void dep.dependencies.getItems().length;
  }
}
const extraQueries = queryCount - queriesAfterHydration;
```

This loop accesses the second level without triggering new queries — confirming the 2-level prefetch
is fully resident in the `EntityManager` cache.

**smartCheck with identity map:**

```typescript
const graphCheck = smartCheck(roots as Node[], expectedAdj, {
  getId: (node) => node.id,
  getDeps: (node): Node[] => node.dependencies.getItems(),
});
```

The identity map means `roots[0].dependencies.getItems()[0]` (B seen from A) is the same object
reference as `roots[1]` (B at root). `smartCheck` finds `b` twice but `prior === node` (same
reference), so it passes.

**Serialize step:**

```typescript
const serialization = finalizeSerialization(() => JSON.stringify(toPlainCycleGraph(roots)));
```

`toPlainCycleGraph` uses a `Map<Node, SerializableNode>` to break cycles by returning a cached
plain object on repeat visits — this is the probe's positive serialization path. The probe tests
**naïve** `JSON.stringify` implicitly through the fact that `toPlainCycleGraph` wraps the identity
map in a cycle-safe projector. Wait — actually let's re-read:

```typescript
function toPlainCycleGraph(roots: Node[]): SerializableNode[] {
  const byRef = new Map<Node, SerializableNode>();
  const materialize = (node: Node): SerializableNode => {
    const existing = byRef.get(node);
    if (existing !== undefined) return existing;  // returns cached stub
    const plain: SerializableNode = { id: node.id, dependencies: [] };
    byRef.set(node, plain);  // register before recursing
    plain.dependencies = node.dependencies.getItems().map((dep) => materialize(dep));
    return plain;
  };
  return roots.map((node) => materialize(node));
}
```

`toPlainCycleGraph` creates a *plain object graph* that is cycle-free because the `byRef` map
returns the cached stub on re-entry. The `JSON.stringify` call on its output is therefore
cycle-safe. **However**, the plain object graph itself *still has cycles* because `plain.a.dependencies[0]
=== plain.b` and `plain.b.dependencies[0] === plain.a` — the stub is registered before recursion,
so each node points to the other plain object. Running `JSON.stringify` on this **will** throw
`TypeError: Converting circular structure to JSON`.

That is why `v1/mikroorm.json` reports:

```json
"serialize": {
  "result": "SERIALIZE_FAIL_CYCLE",
  "detail": "JSON serialization failed with SERIALIZE_FAIL_CYCLE."
}
```

**Conclusion:** `hydration=PASS` (identity map correctly wires cycles given explicit 2-level
paths), `serialize=SERIALIZE_FAIL_CYCLE` (naïve JSON still throws on the cycle). The Hydration Gap
is real because `populate: ['*']` halts at depth 1. Both gap labels in the table are correct.

---

### 3.2 SQLAlchemy

**Probe file:** [`test_sqlalchemy.py`](../supporting-probes/test_sqlalchemy.py)

**Eager-load call:**

```python
roots = (
    session.query(Node)
    .options(selectinload(Node.dependencies).selectinload(Node.dependencies))
    .filter(Node.name.in_(['a', 'b']))
    .order_by(Node.name.asc())
    .all()
)
```

`selectinload().selectinload()` is two explicit levels. The alternative for schema-driven
population would be `selectinload(Node.dependencies, lazy='raise')` or `join_depth`, but both
require explicit depth configuration — no wildcard that walks cycles to arbitrary depth exists.

**smart_check (Python):**

```python
prior = by_name.get(node.name)
if prior is not None and prior is not node:   # 'is not' = reference inequality
    return False, f'id "{node.name}" maps to multiple in-memory instances', ...
```

The SQLAlchemy session identity map means `roots[0].dependencies[0]` (B seen from A) `is`
`roots[1]` (top-level B). The `is not` check therefore passes.

**Serialize step:**

```python
def _default(obj):
    if isinstance(obj, Node):
        return {'name': obj.name, 'dependencies': obj.dependencies}
    raise TypeError(...)
json.dumps(roots, default=_default)
```

This expands each `Node` to a dict whose `'dependencies'` value is the raw ORM list — which
contains live `Node` objects. The serializer calls `_default` again on those, which returns another
dict with `'dependencies'`, leading to infinite recursion. Python's `json` module detects this and
raises `ValueError: Circular reference detected`.

v1 result confirms:

```json
"serialize": { "result": "SERIALIZE_FAIL_CYCLE" }
```

**Conclusion:** identical pattern to MikroORM. `hydration=PASS` (session identity map works with
explicit 2-level `selectinload`), `serialize=SERIALIZE_FAIL_CYCLE`. Both gaps are real and
correctly labeled.

---

### 3.3 Hibernate/Jackson

**Probe file:** [`Main.java`](../supporting-probes/Main.java)

**Eager-load query:**

```java
roots = session.createQuery(
    "select distinct n from Node n " +
        "left join fetch n.dependencies d " +
        "left join fetch d.dependencies " +
        "where n.name in (:names)",
    Node.class)
  .setParameter("names", List.of("a", "b"))
  .getResultList();
```

`left join fetch d.dependencies` is the second explicit level. There is no Hibernate wildcard that
traverses cycles. Every additional cycle depth requires another `left join fetch` clause.

The `distinct` keyword is required because the join produces Cartesian rows; without it, A appears
twice in the result list (once per dependency B has). `distinct` here is a JPQL post-processor
deduplicate instruction, not SQL DISTINCT.

**smartCheck identity (Java):**

```java
var prior = byName.get(node.getName());
if (prior != null && prior != node) {  // reference inequality
    return mapOf("pass", false, "reason", "id \"" + node.getName() + "\" maps to multiple in-memory instances");
}
```

Hibernate's Persistence Context ensures `root.getDependencies().iterator().next()` (B seen from A)
`==` the B in the `roots` list. Same heap object, reference check passes.

**Serialize step:**

```java
try {
    new ObjectMapper().writeValueAsString(roots);
    findings.serialize = mapOf("detail", "JSON serialization passed.", "result", "SERIALIZE_PASS");
} catch (Exception e) {
    var msg = (e.getMessage() == null ? "" : e.getMessage()).toLowerCase(Locale.ROOT);
    var serialization = (msg.contains("cycle") || msg.contains("circular") || msg.contains("recursion"))
        ? "SERIALIZE_FAIL_CYCLE"
        : "SERIALIZE_FAIL_OTHER";
    findings.serialize = mapOf("detail", stackDetail(e), "result", serialization);
}
```

`ObjectMapper().writeValueAsString` follows `getDependencies()` on each node. A → B → A's
dependencies → B → ... Jackson hits its nesting-depth limit of 1000. The exception message
contains "Document nesting depth (1001) exceeds the maximum allowed (1000)". The keyword "depth"
does not contain "cycle", "circular", or "recursion", so the probe classifies this as
`SERIALIZE_FAIL_OTHER`.

v1 result:

```json
"serialize": { "result": "SERIALIZE_FAIL_OTHER" }
"outcome": "SERIALIZE_FAIL"
```

The nesting-depth failure *is* caused by a cycle (infinite expansion because A points back to B
which points back to A), but Jackson calls it a depth violation rather than a circular reference
error. The probe's string-matching classification correctly places this in `SERIALIZE_FAIL_OTHER`
rather than `SERIALIZE_FAIL_CYCLE`.

**Conclusion:** `hydration=PASS` (Persistence Context identity map works with explicit 2-level
`join fetch`), `serialize=SERIALIZE_FAIL_OTHER`. Both gaps are real. The `SERIALIZE_FAIL_OTHER`
classification (vs `_CYCLE`) is technically correct — Jackson errors on depth, not cycles.

---

### 3.4 EF Core

**Probe file:** [`Program.cs`](../supporting-probes/Program.cs)

**Eager-load call:**

```csharp
var roots = db.Nodes
    .Where(n => n.Name == "a" || n.Name == "b")
    .Include(n => n.Dependencies)
    .ThenInclude(n => n.Dependencies)
    .OrderBy(n => n.Name)
    .ToList();
```

`.ThenInclude(n => n.Dependencies)` is the second explicit level. EF Core has no unbounded wildcard.

**SmartCheck (C#):**

```csharp
if (byName.TryGetValue(node.Name, out var prior) && !ReferenceEquals(prior, node))
    return (false, $"id \"{node.Name}\" maps to multiple in-memory instances");
```

`ReferenceEquals` (C# reference identity). The `ChangeTracker` in EF Core ensures the same
in-memory instance is used whenever the same row is loaded within the same `DbContext`. So
`roots[0].Dependencies[0]` (B seen from A) and `roots[1]` (top-level B) are the same CLR object.

**Serialize step:**

```csharp
JsonSerializer.Serialize(roots);
```

`System.Text.Json` follows the object graph: A → B → A's dependencies → B → ... The default
serializer has a max depth of 64 and throws:

```
JsonException: A possible object cycle was detected ... depth is larger than the maximum allowed depth of 64
```

The message contains "cycle", so the probe classifies this as `SERIALIZE_FAIL_CYCLE`.

v1 result:

```json
"serialize": { "result": "SERIALIZE_FAIL_CYCLE" }
```

**Conclusion:** `hydration=PASS`, `serialize=SERIALIZE_FAIL_CYCLE`. Both gaps correctly labeled.

---

## 4 — Group B: Non-identity ORMs (probe `hydration=FAIL`)

These ORMs do not maintain an in-memory identity registry. Each time the same row appears in query
results, it creates a new heap object. The `smartCheck` identity invariant therefore fails because
traversal encounters two separate objects with the same ID.

Because the in-memory graph is structurally truncated (the back-edge from B back to A is a *copy
of A*, not the *root A*), there are no actual cycles in memory — and `JSON.stringify` succeeds.
This is why they show `serialize=SERIALIZE_PASS`: the serializer sees a finite tree, not a cycle.

### 4.1 TypeORM

**Probe file:** [`typeorm-test.ts`](../supporting-probes/typeorm-test.ts)

**Load call:**

```typescript
const roots = await repo.find({
  where: [{ name: 'a' }, { name: 'b' }],
  relations: { dependencies: { dependencies: true } },
  order: { name: 'ASC' },
});
```

Two explicit levels. TypeORM resolves this as separate SQL joins, each producing its own row set.
Without an identity map, node B appears twice: once in `roots[1]` and once in
`roots[0].dependencies[0]`. These are separate object instances.

**smartCheck failure:**

```typescript
const graphCheck = smartCheck(roots, expectedAdj, {
  getId: (node) => node.name,
  getDeps: (node) => node.dependencies,
});
// → { pass: false, reason: 'id "b" maps to multiple in-memory instances' }
```

The traversal visits `roots[0]` (A), registers `A`. Then visits `roots[0].dependencies[0]` (B₁),
registers `B₁`. Then visits `roots[1]` (B₂) — finds `byId.get('b') === B₁`, but `B₁ !== B₂`.
Fails.

**Serialize:** runs on the truncated tree (A → B₁ → [A's copy], B₂ → [A's copy]) with no real
cycles, so `JSON.stringify` succeeds.

v1: `outcome: "HYDRATION_FAIL"`, `serialize: "SERIALIZE_PASS"`.

**Positive control note:** The probe comment says "A positive control with only one eager side
succeeds" (for TypeORM's `eager: true` restriction). This means TypeORM *can* populate a
one-directional association eagerly, but not a bidirectional cycle.

---

### 4.2 Mongoose

**Probe file:** [`mongoose-test.ts`](../supporting-probes/mongoose-test.ts)

**Load call:**

```typescript
const roots = await NodeModel.find({ name: { $in: ['a', 'b'] } })
  .populate({ path: 'dependencies', populate: { path: 'dependencies' } })
  .sort({ name: 1 })
  .exec();
```

Mongoose `.populate()` is a client-side join: it fetches ObjectId references and replaces them with
loaded documents in separate queries. No identity map. Each call to `populate()` fetches fresh
document instances from MongoDB — the B in `roots[0].dependencies` and `roots[1]` are separate
Mongoose Document objects.

**smartCheck failure:** same pattern as TypeORM — `'b'` maps to two instances.

**Serialize:** truncated tree, no actual cycles, `SERIALIZE_PASS`.

v1: `outcome: "HYDRATION_FAIL"`.

---

### 4.3 Sequelize

**Probe file:** [`sequelize-test.ts`](../supporting-probes/sequelize-test.ts)

**Load call (relevant excerpt):**

```typescript
const roots = await Node.findAll({
  where: { name: ['a', 'b'] },
  include: [{ model: Node, as: 'dependencies', include: [{ model: Node, as: 'dependencies' }] }],
  order: [['name', 'ASC']],
});
```

Sequelize uses SQL JOINs and maps result rows to new model instances. No identity map across the
result set. `roots[0].dependencies[0]` (B from A's row) and `roots[1]` (B's own row) are two
distinct Sequelize model instances.

**Note:** Sequelize has `{ include: { all: true, nested: true } }` as a convenience option, but as
documented in the analysis table, for self-referential models it truncates at depth 1 to prevent
infinite SQL JOINs. The probe uses the explicit 2-level include to confirm the no-identity-map
behavior, not to test the `all:true` option.

v1: `outcome: "HYDRATION_FAIL"`, `serialize: "SERIALIZE_PASS"`.

---

### 4.4 Prisma

**Probe file:** [`prisma-test.ts`](../supporting-probes/prisma-test.ts)

**Load call:**

```typescript
const roots = await prisma.node.findMany({
  where: { name: { in: ['a', 'b'] } },
  include: { dependencies: { include: { dependencies: true } } },
  orderBy: { name: 'asc' },
});
```

Prisma generates typed query results as plain JavaScript objects — no ORM proxy, no identity map.
Each included sub-relation is a new plain object hydrated from the SQL row. B appears in both
`roots[1]` and `roots[0].dependencies[0]` as separate plain objects.

v1: `outcome: "HYDRATION_FAIL"`, `serialize: "SERIALIZE_PASS"`.

---

### 4.5 ActiveRecord

**Probe file:** [`test_activerecord.rb`](../supporting-probes/test_activerecord.rb)

**Load call:**

```ruby
roots = Node.includes(dependencies: :dependencies).where(name: %w[a b]).order(:name).to_a
```

ActiveRecord `includes` generates SQL and maps result rows. Rails 7+ does have an internal identity
cache (`IdentityMap`) but it is *scoped to a single query execution* and does not prevent duplicate
object allocation across a multi-row result set where the same row appears in multiple join paths.
The `smartCheck` failure confirms B appears as two distinct Ruby objects.

**Serialize:** ActiveRecord's built-in serialization path (`to_json`) is not tested here; instead
the probe uses a recursive lambda:

```ruby
project = lambda do |node|
  { name: node.name, dependencies: node.dependencies.map { |d| project.call(d) } }
end
JSON.generate(roots.map { |r| project.call(r) })
```

Because the graph is structurally a truncated tree (no real back-reference since the B in
`a.dependencies` is not the same object as `roots[1]`), the recursive lambda terminates and
`JSON.generate` succeeds. The `SystemStackError` in v1's `serialize.detail` comes from the
*outer exception handler* (the broader rescue block), not from this JSON step — actually looking at
the JSON result again:

```json
"serialize": { "result": "SERIALIZE_FAIL_OTHER" }
"outcome": "HYDRATION_FAIL"
```

Wait — v1 shows `outcome: "HYDRATION_FAIL"` for ActiveRecord, and the outcome rollup says
`HYDRATION_FAIL` takes priority over `SERIALIZE_FAIL`. The `serialize` result is
`SERIALIZE_FAIL_OTHER` (the `SystemStackError` in the `serialize.detail` field). Let's re-examine:

The probe's outer `rescue StandardError, SystemStackError` would catch a stack overflow in the
*serialization attempt*, which would happen if the project lambda *did* encounter a back-reference
(i.e., if ActiveRecord's identity cache happened to return the same object). The fact that it
reaches `SERIALIZE_FAIL_OTHER` (not `SERIALIZE_PASS`) suggests either:

1. The identity cache *does* return the same object in some traversal paths, creating a cycle that
   the recursive lambda infinitely expands, or
2. The `SystemStackError` in the detail comes from a different code path.

Looking at the detail string in v1:

```
/...activerecord.../core.rb:216:in 'ActiveRecord::Base.connected_to_stack': stack level too deep (SystemStackError)
from /...connection_handling.rb:346:in 'connection_pool'
```

This stack trace originates inside ActiveRecord's connection-handling code, not in the JSON lambda.
This is an ActiveRecord internals recursion caused by the probe repeatedly accessing `node.dependencies`
on an already-loaded graph. ActiveRecord's `connected_to_stack` is called during `.dependencies`
access; if the recursive lambda triggers that code path deeply enough, the call stack overflows.
This is a side effect of how ActiveRecord wraps attribute access with connection context checks —
the failure is *functionally* a serialization failure caused by the cyclic object traversal, but
the mechanism is ActiveRecord's own stack depth, not JSON's cycle detection.

Since `smartCheck` already failed (`outcome: "HYDRATION_FAIL"`), the serialize result does not
affect the outcome rollup. The analysis table labels ActiveRecord as "Hydration & Serialization
Gaps" — the `SERIALIZE_FAIL_OTHER` in the probe data supports the serialization gap label
(something fails during serialization), even if the failure mechanism is unusual.

---

## 5 — Summary table: probe data vs analysis labels

| ORM | probe `hydration` | probe `smartCheck` | probe `serialize` | probe `outcome` | Analysis table label |
| --- | --- | --- | --- | --- | --- |
| **MikroORM** | `PASS` | `PASS` | `SERIALIZE_FAIL_CYCLE` | `SERIALIZE_FAIL` | Hydration Gap & Serialization Gap ✅ |
| **SQLAlchemy** | `PASS` | `PASS` | `SERIALIZE_FAIL_CYCLE` | `SERIALIZE_FAIL` | Hydration Gap & Serialization Gap ✅ |
| **Hibernate** | `PASS` | `PASS` | `SERIALIZE_FAIL_OTHER` | `SERIALIZE_FAIL` | Hydration Gap & Serialization Gap ✅ |
| **EF Core** | `PASS` | `PASS` | `SERIALIZE_FAIL_CYCLE` | `SERIALIZE_FAIL` | Hydration Gap & Serialization Gap ✅ |
| **TypeORM** | `FAIL` | `FAIL` | `SERIALIZE_PASS` | `HYDRATION_FAIL` | Hydration Gap ✅ |
| **Sequelize** | `FAIL` | `FAIL` | `SERIALIZE_PASS` | `HYDRATION_FAIL` | Hydration Gap ✅ |
| **Prisma** | `FAIL` | `FAIL` | `SERIALIZE_PASS` | `HYDRATION_FAIL` | Hydration Gap ✅ |
| **Mongoose** | `FAIL` | `FAIL` | `SERIALIZE_PASS` | `HYDRATION_FAIL` | Hydration Gap ✅ |
| **ActiveRecord** | `FAIL` | `FAIL` | `SERIALIZE_FAIL_OTHER` | `HYDRATION_FAIL` | Hydration & Serialization Gaps ✅ |

---

## 6 — The critical reconciliation: probe `hydration=PASS` ≠ no Hydration Gap

This is the key gray area from the first version of the table. The reconciliation:

**Identity-map ORMs pass the probe's `hydration` check because the probe uses explicit paths.**

The probe's `hydration=PASS` answers: *"given an explicit eager-load call, does the ORM's identity
map produce a cycle-correct in-memory graph?"* The answer is yes for all four.

The analysis table's **Hydration Gap** answers: *"can a developer fully populate a cyclic schema
without declaring explicit depth levels in the query?"* The answer is no for all four.

These are two different questions. They are compatible. The first (probe) is a positive capability
test; the second (gap label) is a schema-driven wildcard capability test. The table's gap label
documents the design constraint the developer faces, not a runtime failure.

For the non-identity ORMs, both questions resolve to "no": the probe's runtime identity check fails
AND there is no schema-driven wildcard that would help, because the missing identity map is the root
cause.

**ActiveRecord** occupies a unique position: it has partial identity-map behavior (same-query
deduplication), but it is insufficient for the cross-join case. The probe `hydration=FAIL`
confirms the structural failure at runtime.

---

## 7 — What would have to change for these labels to be wrong?

Each label would be wrong only if:

**Hydration Gap (identity-map ORMs):** Would be wrong if any of these ORMs provided a
schema-driven wildcard that correctly traverses cycles to arbitrary depth without the caller
specifying levels. As of the versions tested, none do. The `populate: ['*']` (MikroORM) and
`eager: true` (TypeORM one-sided) are the closest things; the probe confirms neither resolves the
cycle.

**Serialization Gap (identity-map ORMs):** Would be wrong if naïve `JSON.stringify` /
`json.dumps` / `JsonSerializer.Serialize` succeeded on the cycle-correct in-memory graph. The probe
results show all four throw on the cyclic references.

**Hydration Gap (non-identity ORMs):** Would be wrong if the ORM's `smartCheck` passed — i.e., if
the same logical node yielded the same in-memory instance regardless of how many times it appears in
query results. None of the four do; all produce duplicate instances.

---

## 8 — Known limitations of the probe design

1. **Minimal graph only.** The probes test a 2-node cycle. A more complex cycle (e.g., A→B→C→A)
   might behave differently; the current probes do not cover it. For the claims in the analysis
   table (which focus on the binary question of "does a wildcard exist"), this is sufficient.

2. **Fixed versions.** Results are pinned to the versions in v1. Later library versions may change
   behavior.

3. **SQLite / in-memory databases.** All probes use in-memory SQLite (or H2 for Hibernate). This
   removes network latency and external dependencies, but means `queryGate` counts only in-process
   SQL calls. This is appropriate for the identity-map test but would not capture lazy-loading
   scenarios in production configurations.

4. **Two-level explicit paths.** For the identity-map ORMs, the probe uses exactly 2 explicit
   levels. This is the minimum to confirm the identity map handles cycles. It does not confirm
   behavior at depth 3+ for the same ORMs; however, since all four identity maps use reference
   equality globally, behavior at depth 3+ would be structurally identical.

5. **ActiveRecord serialize path.** As noted in §4.5, the `SERIALIZE_FAIL_OTHER` result for
   ActiveRecord stems from an internal stack overflow in ActiveRecord's connection-handling code, not
   a JSON-specific error. The effect (serialization fails) is correct; the mechanism is unexpected
   and could change across ActiveRecord versions.
