import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ComponentFlat } from '../algorithms/types';
import { validateDataset } from './manifest-validator';
import type { ValidationResult } from './manifest-validator';

// ---------------------------------------------------------------------------
// Typed assertion helpers
//
// Using `asserts r is X` (TypeScript assertion functions) accomplishes two
// things simultaneously:
//   1. Runtime — throws if the classification is wrong (same effect as
//      assert.equal(r.classification, '...')).
//   2. Compile-time — narrows the type of `r` for the rest of the block,
//      so TypeScript can verify that callers only access fields that are
//      guaranteed non-empty for that tier (e.g. `warnings: string[]` for
//      edge-case-only, `errors: string[]` for invalid).
// ---------------------------------------------------------------------------

function assertCoreValid(r: ValidationResult): asserts r is Extract<ValidationResult, { classification: 'core-valid' }> {
  assert.equal(r.classification, 'core-valid');
}

function assertEdgeCaseOnly(r: ValidationResult): asserts r is Extract<ValidationResult, { classification: 'edge-case-only' }> {
  assert.equal(r.classification, 'edge-case-only');
}

function assertInvalid(r: ValidationResult): asserts r is Extract<ValidationResult, { classification: 'invalid' }> {
  assert.equal(r.classification, 'invalid');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLinear(...ids: string[]): ComponentFlat[] {
  // Produces a chain: ids[0] → ids[1] → … → ids[n-1] → (no deps)
  return ids.map((id, i) => ({
    id,
    dependencies: i + 1 < ids.length ? [ids[i + 1]!] : [],
  }));
}

/** Makes a closed cycle: ids[0] → ids[1] → … → ids[n-1] → ids[0] */
function makeCycle(...ids: string[]): ComponentFlat[] {
  return ids.map((id, i) => ({
    id,
    dependencies: [ids[(i + 1) % ids.length]!],
  }));
}

// ---------------------------------------------------------------------------
// Core-valid — auto-detected root (unique zero-in-degree node), all reachable
// ---------------------------------------------------------------------------

void describe('validateDataset — core-valid: auto-detected root, all nodes reachable', () => {
  void it('classifies a single node as core-valid (it is the trivial root and reaches itself)', () => {
    const result = validateDataset([{ id: 'a', dependencies: [] }]);
    assertCoreValid(result);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  void it('classifies a linear chain as core-valid (head has in-degree 0, reaches all)', () => {
    // a → b → c; only 'a' has in-degree 0 → auto-detected root
    const result = validateDataset(makeLinear('a', 'b', 'c'));
    assertCoreValid(result);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  void it('classifies a diamond graph as core-valid (top node has in-degree 0)', () => {
    const components: ComponentFlat[] = [
      { id: 'top', dependencies: ['left', 'right'] },
      { id: 'left', dependencies: ['bottom'] },
      { id: 'right', dependencies: ['bottom'] },
      { id: 'bottom', dependencies: [] },
    ];
    const result = validateDataset(components);
    assertCoreValid(result);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  void it('classifies a cyclic graph as core-valid when the unique zero-in-degree root reaches all nodes via cycles', () => {
    // 'entry' has in-degree 0; a → b → a forms a cycle, but entry can reach both.
    const components: ComponentFlat[] = [
      { id: 'entry', dependencies: ['a', 'c'] },
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: ['a', 'c'] }, // a↔b cycle
      { id: 'c', dependencies: [] },
    ];
    const result = validateDataset(components);
    assertCoreValid(result);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  void it('classifies a hand-authored 10-node graph as core-valid when the unique root reaches all nodes', () => {
    // 'entry' is the only node with no incoming edges.
    const components: ComponentFlat[] = [
      { id: 'entry', dependencies: ['svc_a', 'svc_b'] },
      { id: 'svc_a', dependencies: ['db_x', 'db_y', 'model_4'] },
      { id: 'svc_b', dependencies: ['db_y', 'db_z'] },
      { id: 'db_x', dependencies: ['model_1'] },
      { id: 'db_y', dependencies: ['model_1', 'model_2'] },
      { id: 'db_z', dependencies: ['model_2'] },
      { id: 'model_1', dependencies: ['model_3'] },
      { id: 'model_2', dependencies: ['model_3'] },
      { id: 'model_3', dependencies: [] },
      { id: 'model_4', dependencies: ['model_3'] },
    ];
    const result = validateDataset(components);
    assertCoreValid(result);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });
});

// ---------------------------------------------------------------------------
// Edge-case-only — no unique root detectable
// (0 or >1 nodes with in-degree zero)
// ---------------------------------------------------------------------------

void describe('validateDataset — edge-case-only: no unique root detectable', () => {
  void it('classifies an empty dataset as edge-case-only (no nodes, no root)', () => {
    const result = validateDataset([]);
    assertEdgeCaseOnly(result);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.length > 0, 'should produce a warning');
    assert.ok(result.warnings[0]!.includes('No root detected'), 'warning should mention root detection failure');
  });

  void it('classifies a 2-node cycle as edge-case-only (every node has an incoming edge)', () => {
    // a → b → a: both nodes have in-degree 1, so no zero-in-degree root exists.
    const result = validateDataset(makeCycle('a', 'b'));
    assertEdgeCaseOnly(result);
    assert.deepEqual(result.errors, []);
  });

  void it('classifies a 3-node cycle as edge-case-only', () => {
    const result = validateDataset(makeCycle('x', 'y', 'z'));
    assertEdgeCaseOnly(result);
    assert.deepEqual(result.errors, []);
  });

  void it('classifies a 2-tree forest as edge-case-only (two nodes have in-degree 0)', () => {
    // root_a and root_b each have in-degree 0 — two candidate roots detected.
    const components: ComponentFlat[] = [
      { id: 'root_a', dependencies: ['x'] },
      { id: 'x', dependencies: [] },
      { id: 'root_b', dependencies: ['y'] },
      { id: 'y', dependencies: [] },
    ];
    const result = validateDataset(components);
    assertEdgeCaseOnly(result);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings[0]!.includes('2'), 'warning should report 2 candidate roots');
    assert.ok(result.warnings[0]!.includes('candidate root'), 'warning should describe candidate roots');
  });

  void it('"and N more" suffix appears when more than 5 zero-in-degree nodes exist', () => {
    // Build a star rooted at a single hub, then add 7 standalone roots (in-degree 0).
    const components: ComponentFlat[] = [
      { id: 'hub', dependencies: ['leaf'] },
      { id: 'leaf', dependencies: [] },
      ...Array.from({ length: 7 }, (_, i) => ({ id: `extra_root_${i}`, dependencies: [] })),
    ];
    // hub and all extra_root_N have in-degree 0 → 8 candidates total.
    const result = validateDataset(components);
    assertEdgeCaseOnly(result);
    assert.ok(result.warnings[0]!.includes('8'), 'should report 8 candidate roots');
    assert.ok(result.warnings[0]!.includes('and 3 more'), 'should note overflow with "and 3 more"');
  });
});

// ---------------------------------------------------------------------------
// Edge-case-only — auto-detected root present but some nodes unreachable
// ---------------------------------------------------------------------------

void describe('validateDataset — edge-case-only: unique root detected but nodes are unreachable', () => {
  void it('classifies a graph where a disconnected cycle is unreachable from the root', () => {
    // 'root' has in-degree 0 (auto-detected). b and c form a cycle not reachable from root.
    const components: ComponentFlat[] = [
      { id: 'root', dependencies: ['a'] },
      { id: 'a', dependencies: [] },
      { id: 'b', dependencies: ['c'] }, // b↔c cycle: both have in-degree 1
      { id: 'c', dependencies: ['b'] },
    ];
    const result = validateDataset(components);
    assertEdgeCaseOnly(result);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.length > 0, 'should produce a warning about unreachable nodes');
    // b and c are named in the warning
    assert.ok(result.warnings[0]!.includes('2'), 'warning should note 2 unreachable nodes');
  });

  void it('classifies a graph where the auto-detected root has no outgoing edges', () => {
    // 'start' has in-degree 0 (auto-detected) but no deps — can only reach itself.
    // a and b form a cycle so they have in-degree > 0.
    const components: ComponentFlat[] = [
      { id: 'start', dependencies: [] },
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: ['a'] },
    ];
    const result = validateDataset(components);
    assertEdgeCaseOnly(result);
    assert.ok(result.warnings[0]!.includes('2'), 'a and b are unreachable from start');
  });

  void it('warning lists unreachable node IDs (up to 5 shown by name)', () => {
    // root is the unique zero-in-degree node; b–f form a disconnected cycle.
    const components: ComponentFlat[] = [
      { id: 'root', dependencies: ['a'] },
      { id: 'a', dependencies: [] },
      // disconnected cycle of 5 nodes — all have in-degree > 0
      { id: 'b', dependencies: ['c'] },
      { id: 'c', dependencies: ['d'] },
      { id: 'd', dependencies: ['e'] },
      { id: 'e', dependencies: ['f'] },
      { id: 'f', dependencies: ['b'] },
    ];
    const result = validateDataset(components);
    assertEdgeCaseOnly(result);
    assert.ok(result.warnings[0]!.includes('5'), 'should report exactly 5 unreachable nodes');
  });

  void it('"and N more" suffix appears when more than 5 nodes are unreachable', () => {
    // root is the unique zero-in-degree node; orphan_0–7 form a disconnected cycle.
    const components: ComponentFlat[] = [
      { id: 'root', dependencies: ['a'] },
      { id: 'a', dependencies: [] },
      // disconnected cycle of 8 nodes — all have in-degree > 0
      ...Array.from({ length: 8 }, (_, i) => ({
        id: `orphan_${i}`,
        dependencies: [`orphan_${(i + 1) % 8}`],
      })),
    ];
    const result = validateDataset(components);
    assertEdgeCaseOnly(result);
    assert.ok(result.warnings[0]!.includes('and 3 more'), 'should note overflow count');
  });
});

// ---------------------------------------------------------------------------
// Invalid — duplicate node IDs
// ---------------------------------------------------------------------------

void describe('validateDataset — invalid: duplicate node IDs', () => {
  void it('rejects a dataset with a duplicated node ID', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: [] },
      { id: 'b', dependencies: [] },
      { id: 'a', dependencies: ['b'] }, // duplicate
    ];
    const result = validateDataset(components);
    assertInvalid(result);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0]!.includes('"a"'), 'error should identify the duplicate ID');
  });

  void it('reports all duplicate IDs when multiple appear', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: [] },
      { id: 'a', dependencies: [] },
      { id: 'b', dependencies: [] },
      { id: 'b', dependencies: [] },
    ];
    const result = validateDataset(components);
    assertInvalid(result);
    assert.equal(result.errors.length, 2, 'should report one error per duplicate occurrence');
    assert.ok(result.errors.some((e) => e.includes('"a"')));
    assert.ok(result.errors.some((e) => e.includes('"b"')));
  });

  void it('short-circuits further checks when duplicate IDs are found', () => {
    // The duplicate-ID branch returns early; no edge checks run.
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['missing'] }, // would be a dangling ref if reached
      { id: 'a', dependencies: [] },
    ];
    const result = validateDataset(components);
    assertInvalid(result);
    // Only duplicate-ID errors; dangling-ref check did not run.
    assert.ok(result.errors.every((e) => e.includes('Duplicate node ID')));
  });
});

// ---------------------------------------------------------------------------
// Invalid — dangling references
// ---------------------------------------------------------------------------

void describe('validateDataset — invalid: dangling references', () => {
  void it('rejects a dataset where a dependency points to an unknown node', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['b'] },
      // 'b' is never declared
    ];
    const result = validateDataset(components);
    assertInvalid(result);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0]!.includes('"a"'), 'error should name the source node');
    assert.ok(result.errors[0]!.includes('"b"'), 'error should name the missing target node');
  });

  void it('reports multiple dangling references independently', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['ghost_1', 'ghost_2'] },
      { id: 'b', dependencies: ['ghost_3'] },
    ];
    const result = validateDataset(components);
    assertInvalid(result);
    assert.equal(result.errors.length, 3, 'one error per missing target');
  });

  void it('rejects even when only one edge in an otherwise-valid graph is dangling', () => {
    const components: ComponentFlat[] = [
      { id: 'root', dependencies: ['a', 'missing'] },
      { id: 'a', dependencies: [] },
    ];
    const result = validateDataset(components);
    assertInvalid(result);
    assert.ok(result.errors[0]!.includes('"missing"'));
  });

  void it('error message contains both source and target node IDs', () => {
    const components: ComponentFlat[] = [{ id: 'src', dependencies: ['tgt'] }];
    const result = validateDataset(components);
    assertInvalid(result);
    assert.ok(result.errors[0]!.includes('"src"'), 'error should include source node ID');
    assert.ok(result.errors[0]!.includes('"tgt"'), 'error should include missing target node ID');
  });
});

// ---------------------------------------------------------------------------
// Invalid — duplicate edges
// ---------------------------------------------------------------------------

void describe('validateDataset — invalid: duplicate edges', () => {
  void it('rejects a dataset where the same dependency is listed twice for one node', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['b', 'b'] }, // duplicate edge a→b
      { id: 'b', dependencies: [] },
    ];
    const result = validateDataset(components);
    assertInvalid(result);
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0]!.includes('"a"'), 'error should name the source node');
    assert.ok(result.errors[0]!.includes('"b"'), 'error should name the repeated dependency');
  });

  void it('reports duplicate edges from multiple nodes independently', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['c', 'c'] }, // duplicate a→c
      { id: 'b', dependencies: ['c', 'c'] }, // duplicate b→c
      { id: 'c', dependencies: [] },
    ];
    const result = validateDataset(components);
    assertInvalid(result);
    assert.equal(result.errors.length, 2, 'one duplicate-edge error per source node');
  });

  void it('does not report duplicate edges when two different nodes each have a single edge to the same target', () => {
    // a→c and b→c are two distinct edges from different sources — not duplicates.
    // 'hub' has in-degree 0 → auto-detected root → reaches all → core-valid.
    const components: ComponentFlat[] = [
      { id: 'hub', dependencies: ['a', 'b'] },
      { id: 'a', dependencies: ['c'] },
      { id: 'b', dependencies: ['c'] },
      { id: 'c', dependencies: [] },
    ];
    const result = validateDataset(components);
    assertCoreValid(result);
    assert.deepEqual(result.errors, []);
  });

  void it('reports both a dangling reference and a duplicate edge when both errors exist in one node', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['b', 'b', 'ghost'] },
      { id: 'b', dependencies: [] },
    ];
    const result = validateDataset(components);
    assertInvalid(result);
    // Expect one duplicate-edge error (a→b twice) and one dangling-reference error (ghost).
    assert.equal(result.errors.length, 2);
    assert.ok(result.errors.some((e) => e.includes('Duplicate edge')));
    assert.ok(result.errors.some((e) => e.includes('Dangling reference')));
  });
});

// ---------------------------------------------------------------------------
// Classification semantics — verify the three-tier model end-to-end
// ---------------------------------------------------------------------------

void describe('validateDataset — classification semantics', () => {
  void it('errors array is always [] for core-valid and edge-case-only results', () => {
    // core-valid: 'r' has in-degree 0, reaches 'a'.
    const coreComponents: ComponentFlat[] = [
      { id: 'r', dependencies: ['a'] },
      { id: 'a', dependencies: [] },
    ];
    // edge-case-only: 'r' and 'orphan' both have in-degree 0 → multi-root.
    const edgeCaseComponents: ComponentFlat[] = [
      { id: 'r', dependencies: ['a'] },
      { id: 'a', dependencies: [] },
      { id: 'orphan', dependencies: [] },
    ];

    const coreResult = validateDataset(coreComponents);
    const edgeCaseResult = validateDataset(edgeCaseComponents);

    assertCoreValid(coreResult);
    assertEdgeCaseOnly(edgeCaseResult);
    assert.deepEqual(coreResult.errors, []);
    assert.deepEqual(edgeCaseResult.errors, []);
  });

  void it('warnings array is always [] for core-valid and invalid results', () => {
    const coreComponents: ComponentFlat[] = [
      { id: 'r', dependencies: ['a'] },
      { id: 'a', dependencies: [] },
    ];
    const invalidComponents: ComponentFlat[] = [{ id: 'x', dependencies: ['ghost'] }];

    const coreResult = validateDataset(coreComponents);
    const invalidResult = validateDataset(invalidComponents);

    assertCoreValid(coreResult);
    assertInvalid(invalidResult);
    assert.deepEqual(coreResult.warnings, []);
    assert.deepEqual(invalidResult.warnings, []);
  });

  void it('invalid takes precedence over edge-case-only (hard errors are not warnings)', () => {
    // The graph has a dangling ref (→ invalid) and structural multi-root (→ would be edge-case).
    // The result must be invalid, not edge-case-only.
    const components: ComponentFlat[] = [
      { id: 'root', dependencies: ['a', 'ghost'] }, // ghost is dangling
      { id: 'a', dependencies: [] },
      { id: 'disconnected', dependencies: [] }, // second zero-in-degree candidate
    ];
    const result = validateDataset(components);
    assertInvalid(result);
    assert.ok(result.errors.length > 0);
    // The multi-root warning is never generated for invalid datasets.
    assert.deepEqual(result.warnings, []);
  });

  void it('multi-root forest is classified edge-case-only when the graph is otherwise sound', () => {
    // tree_a_root and tree_b_root both have in-degree 0 → 2 candidate roots detected.
    const components: ComponentFlat[] = [
      { id: 'tree_a_root', dependencies: ['a1'] },
      { id: 'a1', dependencies: [] },
      { id: 'tree_b_root', dependencies: ['b1'] },
      { id: 'b1', dependencies: [] },
    ];
    const result = validateDataset(components);
    assertEdgeCaseOnly(result);
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.length > 0, 'should produce a multi-root warning');
    assert.ok(result.warnings[0]!.includes('2'), 'should report 2 candidate roots');
  });
});

// ---------------------------------------------------------------------------
// Hand-authored fixtures not produced by the generator
// ---------------------------------------------------------------------------

void describe('validateDataset — hand-authored fixtures (not generator-produced)', () => {
  void it('accepts a self-loop (node depends on itself) as core-valid when the unique root reaches it', () => {
    // 'root' has in-degree 0 (auto-detected); self_loop has in-degree 2 (from root + itself).
    const components: ComponentFlat[] = [
      { id: 'root', dependencies: ['self_loop'] },
      { id: 'self_loop', dependencies: ['self_loop'] },
    ];
    const result = validateDataset(components);
    assertCoreValid(result);
  });

  void it('rejects a graph with a self-loop that also has a duplicate of that self-loop', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['a', 'a'] }, // self-loop listed twice
    ];
    const result = validateDataset(components);
    assertInvalid(result);
    assert.ok(result.errors.some((e) => e.includes('Duplicate edge')));
  });

  void it('accepts a deeply nested star pattern (fan-out hub) as core-valid', () => {
    // Hub has many spokes; hub has in-degree 0 → auto-detected root → all reachable.
    const spokes = Array.from({ length: 20 }, (_, i) => ({ id: `spoke_${i}`, dependencies: [] }));
    const hub: ComponentFlat = { id: 'hub', dependencies: spokes.map((s) => s.id) };
    const result = validateDataset([hub, ...spokes]);
    assertCoreValid(result);
  });

  void it('rejects a graph where every node has a dangling reference (completely corrupt manifest)', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['x1'] },
      { id: 'b', dependencies: ['x2'] },
      { id: 'c', dependencies: ['x3'] },
    ];
    const result = validateDataset(components);
    assertInvalid(result);
    assert.equal(result.errors.length, 3, 'one error per dangling reference');
  });

  void it('classifies a multi-root forest as edge-case-only (r1 and r2 both have in-degree 0)', () => {
    const components: ComponentFlat[] = [
      { id: 'r1', dependencies: ['a', 'b'] },
      { id: 'r2', dependencies: ['c'] },
      { id: 'a', dependencies: [] },
      { id: 'b', dependencies: [] },
      { id: 'c', dependencies: [] },
    ];
    const result = validateDataset(components);
    assertEdgeCaseOnly(result);
    assert.ok(result.warnings[0]!.includes('candidate root'), 'warning should describe multiple candidate roots');
    assert.ok(result.warnings[0]!.includes('2'), 'warning should report 2 candidate roots');
  });

  void it('classifies a fully cyclic graph (no zero-in-degree node) as edge-case-only', () => {
    // Every node participates in the cycle: a → b → c → a
    const result = validateDataset(makeCycle('a', 'b', 'c'));
    assertEdgeCaseOnly(result);
    assert.ok(result.warnings[0]!.includes('No root detected'), 'warning should explain no root was found');
  });
});
