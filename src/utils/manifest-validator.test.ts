import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ComponentFlat } from '../algorithms/types';
import { validateDataset } from './manifest-validator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLinear(...ids: string[]): ComponentFlat[] {
  // Produces a chain: ids[0] → ids[1] → … → ids[n-1] → (no deps)
  return ids.map((id, i) => ({
    id,
    dependencies: i + 1 < ids.length ? [ids[i + 1]] : [],
  }));
}

// ---------------------------------------------------------------------------
// Edge-case-only — no declared root (root-reachability cannot be verified)
// ---------------------------------------------------------------------------

describe('validateDataset — edge-case-only: no declared root', () => {
  it('classifies an empty dataset without a root as edge-case-only', () => {
    const result = validateDataset([]);
    assert.equal(result.classification, 'edge-case-only');
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.length > 0, 'should produce a no-root warning');
    assert.ok(result.warnings[0].includes('No root declared'), 'warning should mention missing root');
  });

  it('classifies a single node without a root as edge-case-only', () => {
    const result = validateDataset([{ id: 'a', dependencies: [] }]);
    assert.equal(result.classification, 'edge-case-only');
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings[0].includes('No root declared'));
  });

  it('classifies a linear chain without a root as edge-case-only', () => {
    const result = validateDataset(makeLinear('a', 'b', 'c'));
    assert.equal(result.classification, 'edge-case-only');
    assert.deepEqual(result.errors, []);
  });

  it('classifies a 2-node cycle without a root as edge-case-only', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: ['a'] },
    ];
    const result = validateDataset(components);
    assert.equal(result.classification, 'edge-case-only');
  });

  it('classifies a diamond graph without a root as edge-case-only', () => {
    const components: ComponentFlat[] = [
      { id: 'root', dependencies: ['left', 'right'] },
      { id: 'left', dependencies: ['shared'] },
      { id: 'right', dependencies: ['shared'] },
      { id: 'shared', dependencies: [] },
    ];
    const result = validateDataset(components);
    assert.equal(result.classification, 'edge-case-only');
    assert.deepEqual(result.errors, []);
  });

  it('warning message explains how to fix the missing-root issue', () => {
    const result = validateDataset([{ id: 'x', dependencies: [] }]);
    assert.ok(result.warnings[0].includes('manifest entry'), 'warning should hint at the fix');
  });
});

describe('validateDataset — core-valid: declared root, all nodes reachable', () => {
  it('classifies a linear chain as core-valid when root is the chain head', () => {
    const result = validateDataset(makeLinear('a', 'b', 'c'), { root: 'a' });
    assert.equal(result.classification, 'core-valid');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  it('classifies a diamond graph as core-valid when root is the top node', () => {
    const components: ComponentFlat[] = [
      { id: 'top', dependencies: ['left', 'right'] },
      { id: 'left', dependencies: ['bottom'] },
      { id: 'right', dependencies: ['bottom'] },
      { id: 'bottom', dependencies: [] },
    ];
    const result = validateDataset(components, { root: 'top' });
    assert.equal(result.classification, 'core-valid');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  it('classifies a cyclic graph as core-valid when root can reach all nodes via the cycle', () => {
    // root → a → b → root (cycle), plus b → c (leaf)
    const components: ComponentFlat[] = [
      { id: 'root', dependencies: ['a'] },
      { id: 'a', dependencies: ['b'] },
      { id: 'b', dependencies: ['root', 'c'] },
      { id: 'c', dependencies: [] },
    ];
    const result = validateDataset(components, { root: 'root' });
    assert.equal(result.classification, 'core-valid');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });

  it('classifies a hand-authored 10-node graph as core-valid when root reaches all nodes', () => {
    // Mirrors the real-world "start from the entry-point, hydrate closure" pattern.
    const components: ComponentFlat[] = [
      { id: 'entry', dependencies: ['svc_a', 'svc_b'] },
      { id: 'svc_a', dependencies: ['db_x', 'db_y'] },
      { id: 'svc_b', dependencies: ['db_y', 'db_z'] },
      { id: 'db_x', dependencies: ['model_1'] },
      { id: 'db_y', dependencies: ['model_1', 'model_2'] },
      { id: 'db_z', dependencies: ['model_2'] },
      { id: 'model_1', dependencies: ['model_3'] },
      { id: 'model_2', dependencies: ['model_3'] },
      { id: 'model_3', dependencies: [] },
      { id: 'model_4', dependencies: ['model_3'] },
    ];
    // model_4 is added by svc_a's second path
    // Let's wire svc_a → model_4 as well to make it reachable
    components[1] = { id: 'svc_a', dependencies: ['db_x', 'db_y', 'model_4'] };

    const result = validateDataset(components, { root: 'entry' });
    assert.equal(result.classification, 'core-valid');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
  });
});

// ---------------------------------------------------------------------------
// Edge-case-only — structurally sound but not fully root-reachable
// ---------------------------------------------------------------------------

describe('validateDataset — edge-case-only: unreachable nodes with declared root', () => {
  it('classifies a graph with an orphaned (disconnected) node as edge-case-only', () => {
    const components: ComponentFlat[] = [
      { id: 'root', dependencies: ['a'] },
      { id: 'a', dependencies: [] },
      { id: 'orphan', dependencies: [] }, // not reachable from root
    ];
    const result = validateDataset(components, { root: 'root' });
    assert.equal(result.classification, 'edge-case-only');
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.length > 0, 'should produce a warning about unreachable node');
    assert.ok(result.warnings[0].includes('orphan'), 'warning should name the unreachable node');
  });

  it('classifies a multi-root forest as edge-case-only when root is one of the trees', () => {
    // Two completely disconnected trees: root_a→x and root_b→y
    const components: ComponentFlat[] = [
      { id: 'root_a', dependencies: ['x'] },
      { id: 'x', dependencies: [] },
      { id: 'root_b', dependencies: ['y'] },
      { id: 'y', dependencies: [] },
    ];
    const result = validateDataset(components, { root: 'root_a' });
    assert.equal(result.classification, 'edge-case-only');
    assert.deepEqual(result.errors, []);
    // root_b and y are not reachable from root_a
    assert.ok(result.warnings.length > 0);
    const warningText = result.warnings[0];
    assert.ok(warningText.includes('2'), 'should note 2 unreachable nodes');
  });

  it('classifies a graph where root is a sink (no outgoing edges) but other nodes exist as edge-case-only', () => {
    // root has no dependencies so can only reach itself; b, c are unreachable
    const components: ComponentFlat[] = [
      { id: 'root', dependencies: [] },
      { id: 'b', dependencies: ['root'] },
      { id: 'c', dependencies: ['b'] },
    ];
    const result = validateDataset(components, { root: 'root' });
    assert.equal(result.classification, 'edge-case-only');
    assert.ok(result.warnings[0].includes('2'), 'should note 2 unreachable nodes');
  });

  it('warning lists unreachable node IDs (up to 5 shown by name)', () => {
    const components: ComponentFlat[] = [
      { id: 'root', dependencies: ['a'] },
      { id: 'a', dependencies: [] },
      { id: 'b', dependencies: [] },
      { id: 'c', dependencies: [] },
      { id: 'd', dependencies: [] },
      { id: 'e', dependencies: [] },
      { id: 'f', dependencies: [] }, // 5 orphans: b, c, d, e, f
    ];
    const result = validateDataset(components, { root: 'root' });
    assert.equal(result.classification, 'edge-case-only');
    assert.ok(result.warnings[0].includes('5'), 'should report 5 unreachable nodes');
  });

  it('"and N more" suffix appears when more than 5 nodes are unreachable', () => {
    const components: ComponentFlat[] = [
      { id: 'root', dependencies: [] },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `orphan_${i}`, dependencies: [] })),
    ];
    const result = validateDataset(components, { root: 'root' });
    assert.equal(result.classification, 'edge-case-only');
    assert.ok(result.warnings[0].includes('and 3 more'), 'should mention overflow count');
  });
});

// ---------------------------------------------------------------------------
// Invalid — hard structural errors
// ---------------------------------------------------------------------------

describe('validateDataset — invalid: duplicate node IDs', () => {
  it('rejects a dataset with a duplicated node ID', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: [] },
      { id: 'b', dependencies: [] },
      { id: 'a', dependencies: ['b'] }, // duplicate
    ];
    const result = validateDataset(components);
    assert.equal(result.classification, 'invalid');
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes('"a"'), 'error should identify the duplicate ID');
  });

  it('reports all duplicate IDs when multiple appear', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: [] },
      { id: 'a', dependencies: [] },
      { id: 'b', dependencies: [] },
      { id: 'b', dependencies: [] },
    ];
    const result = validateDataset(components);
    assert.equal(result.classification, 'invalid');
    assert.equal(result.errors.length, 2, 'should report one error per duplicate occurrence');
    assert.ok(result.errors.some((e) => e.includes('"a"')));
    assert.ok(result.errors.some((e) => e.includes('"b"')));
  });

  it('short-circuits further checks when duplicate IDs are found', () => {
    // The duplicate-ID branch returns early; no edge checks run.
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['missing'] }, // would be a dangling ref if reached
      { id: 'a', dependencies: [] },
    ];
    const result = validateDataset(components);
    assert.equal(result.classification, 'invalid');
    // Only duplicate-ID errors; dangling-ref check did not run.
    assert.ok(result.errors.every((e) => e.includes('Duplicate node ID')));
  });
});

describe('validateDataset — invalid: dangling references', () => {
  it('rejects a dataset where a dependency points to an unknown node', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['b'] },
      // 'b' is never declared
    ];
    const result = validateDataset(components);
    assert.equal(result.classification, 'invalid');
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes('"a"'), 'error should name the source node');
    assert.ok(result.errors[0].includes('"b"'), 'error should name the missing target node');
  });

  it('reports multiple dangling references independently', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['ghost_1', 'ghost_2'] },
      { id: 'b', dependencies: ['ghost_3'] },
    ];
    const result = validateDataset(components);
    assert.equal(result.classification, 'invalid');
    assert.equal(result.errors.length, 3, 'one error per missing target');
  });

  it('rejects even when only one edge in an otherwise-valid graph is dangling', () => {
    const components: ComponentFlat[] = [
      { id: 'root', dependencies: ['a', 'missing'] },
      { id: 'a', dependencies: [] },
    ];
    const result = validateDataset(components);
    assert.equal(result.classification, 'invalid');
    assert.ok(result.errors[0].includes('"missing"'));
  });

  it('error message contains both source and target node IDs', () => {
    const components: ComponentFlat[] = [{ id: 'src', dependencies: ['tgt'] }];
    const result = validateDataset(components);
    assert.equal(result.classification, 'invalid');
    const err = result.errors[0];
    assert.ok(err.includes('"src"'), 'error should include source node ID');
    assert.ok(err.includes('"tgt"'), 'error should include missing target node ID');
  });
});

describe('validateDataset — invalid: duplicate edges', () => {
  it('rejects a dataset where the same dependency is listed twice for one node', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['b', 'b'] }, // duplicate edge a→b
      { id: 'b', dependencies: [] },
    ];
    const result = validateDataset(components);
    assert.equal(result.classification, 'invalid');
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes('"a"'), 'error should name the source node');
    assert.ok(result.errors[0].includes('"b"'), 'error should name the repeated dependency');
  });

  it('reports duplicate edges from multiple nodes independently', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['c', 'c'] }, // duplicate a→c
      { id: 'b', dependencies: ['c', 'c'] }, // duplicate b→c
      { id: 'c', dependencies: [] },
    ];
    const result = validateDataset(components);
    assert.equal(result.classification, 'invalid');
    assert.equal(result.errors.length, 2, 'one duplicate-edge error per source node');
  });

  it('does not report duplicate edges when two different nodes each have a single edge to the same target', () => {
    // a→c and b→c are two distinct edges from different sources — not duplicates.
    // A hub node reaches both so the dataset is core-valid.
    const components: ComponentFlat[] = [
      { id: 'hub', dependencies: ['a', 'b'] },
      { id: 'a', dependencies: ['c'] },
      { id: 'b', dependencies: ['c'] },
      { id: 'c', dependencies: [] },
    ];
    const result = validateDataset(components, { root: 'hub' });
    assert.equal(result.classification, 'core-valid');
    assert.deepEqual(result.errors, []);
  });

  it('reports both a dangling reference and a duplicate edge when both errors exist in one node', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['b', 'b', 'ghost'] },
      { id: 'b', dependencies: [] },
    ];
    const result = validateDataset(components);
    assert.equal(result.classification, 'invalid');
    // Expect one duplicate-edge error (a→b twice) and one dangling-reference error (ghost).
    assert.equal(result.errors.length, 2);
    assert.ok(result.errors.some((e) => e.includes('Duplicate edge')));
    assert.ok(result.errors.some((e) => e.includes('Dangling reference')));
  });
});

describe('validateDataset — invalid: nonexistent declared root', () => {
  it('rejects when the declared root is not in the dataset', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: [] },
      { id: 'b', dependencies: [] },
    ];
    const result = validateDataset(components, { root: 'missing_root' });
    assert.equal(result.classification, 'invalid');
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].includes('"missing_root"'), 'error should name the missing root');
  });

  it('reports the root-missing error even when structural checks passed', () => {
    const result = validateDataset([{ id: 'a', dependencies: [] }], { root: 'not_a' });
    assert.equal(result.classification, 'invalid');
    assert.ok(result.errors[0].includes('does not exist'));
  });
});

// ---------------------------------------------------------------------------
// Classification semantics — verify the three-tier model end-to-end
// ---------------------------------------------------------------------------

describe('validateDataset — classification semantics', () => {
  it('errors array is always empty for core-valid and edge-case-only results', () => {
    const coreComponents: ComponentFlat[] = [
      { id: 'r', dependencies: ['a'] },
      { id: 'a', dependencies: [] },
    ];
    const edgeCaseComponents: ComponentFlat[] = [
      { id: 'r', dependencies: ['a'] },
      { id: 'a', dependencies: [] },
      { id: 'orphan', dependencies: [] },
    ];

    const coreResult = validateDataset(coreComponents, { root: 'r' });
    const edgeCaseResult = validateDataset(edgeCaseComponents, { root: 'r' });

    assert.deepEqual(coreResult.errors, []);
    assert.deepEqual(edgeCaseResult.errors, []);
  });

  it('warnings array is always empty for core-valid and invalid results', () => {
    const coreComponents: ComponentFlat[] = [
      { id: 'r', dependencies: ['a'] },
      { id: 'a', dependencies: [] },
    ];
    const invalidComponents: ComponentFlat[] = [{ id: 'x', dependencies: ['ghost'] }];

    const coreResult = validateDataset(coreComponents, { root: 'r' });
    const invalidResult = validateDataset(invalidComponents);

    assert.deepEqual(coreResult.warnings, []);
    assert.deepEqual(invalidResult.warnings, []);
  });

  it('invalid takes precedence over edge-case-only (hard errors are not warnings)', () => {
    // The graph has both a dangling ref (invalid) and a disconnected node (edge-case).
    // The result must be invalid, not edge-case-only.
    const components: ComponentFlat[] = [
      { id: 'root', dependencies: ['a', 'ghost'] }, // ghost is dangling
      { id: 'a', dependencies: [] },
      { id: 'disconnected', dependencies: [] },
    ];
    const result = validateDataset(components, { root: 'root' });
    assert.equal(result.classification, 'invalid');
    assert.ok(result.errors.length > 0);
    // The unreachable-node warning is never generated for invalid datasets.
    assert.deepEqual(result.warnings, []);
  });

  it('root-existence failure (invalid) takes precedence over reachability concerns', () => {
    const components: ComponentFlat[] = [{ id: 'a', dependencies: [] }];
    const result = validateDataset(components, { root: 'nonexistent' });
    assert.equal(result.classification, 'invalid');
    // No warnings — error already terminates classification before the reachability check.
    assert.deepEqual(result.warnings, []);
  });

  it('dataset without declared root is classified edge-case-only (root required for core-valid)', () => {
    // A dataset must declare a root to qualify as core-valid.
    // Without a root declaration, root-reachability cannot be verified, so
    // the dataset is edge-case-only regardless of structural soundness.
    const components: ComponentFlat[] = [
      { id: 'tree_a_root', dependencies: ['a1'] },
      { id: 'a1', dependencies: [] },
      { id: 'tree_b_root', dependencies: ['b1'] },
      { id: 'b1', dependencies: [] },
    ];
    const result = validateDataset(components);
    assert.equal(result.classification, 'edge-case-only');
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.length > 0, 'should produce a no-root warning');
  });
});

// ---------------------------------------------------------------------------
// Hand-authored fixtures not produced by the generator
// ---------------------------------------------------------------------------

describe('validateDataset — hand-authored fixtures (not generator-produced)', () => {
  it('accepts a self-loop (node depends on itself) as core-valid when root reaches it', () => {
    // Self-loops are valid simple-digraph edges and appear in real schema cycles.
    const components: ComponentFlat[] = [
      { id: 'root', dependencies: ['self_loop'] },
      { id: 'self_loop', dependencies: ['self_loop'] },
    ];
    const result = validateDataset(components, { root: 'root' });
    assert.equal(result.classification, 'core-valid');
  });

  it('rejects a graph with a self-loop that also has a duplicate of that self-loop', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['a', 'a'] }, // self-loop listed twice
    ];
    const result = validateDataset(components);
    assert.equal(result.classification, 'invalid');
    assert.ok(result.errors.some((e) => e.includes('Duplicate edge')));
  });

  it('accepts a deeply nested star pattern (fan-out hub) as core-valid', () => {
    // Hub has many spokes; all reachable from hub.
    const spokes = Array.from({ length: 20 }, (_, i) => ({ id: `spoke_${i}`, dependencies: [] }));
    const hub: ComponentFlat = { id: 'hub', dependencies: spokes.map((s) => s.id) };
    const result = validateDataset([hub, ...spokes], { root: 'hub' });
    assert.equal(result.classification, 'core-valid');
  });

  it('rejects a graph where every node has a dangling reference (completely corrupt manifest)', () => {
    const components: ComponentFlat[] = [
      { id: 'a', dependencies: ['x1'] },
      { id: 'b', dependencies: ['x2'] },
      { id: 'c', dependencies: ['x3'] },
    ];
    const result = validateDataset(components);
    assert.equal(result.classification, 'invalid');
    assert.equal(result.errors.length, 3, 'one error per dangling reference');
  });

  it('classifies a multi-root forest (no declared root) as edge-case-only', () => {
    // Without a declared root, root-reachability cannot be verified:
    // the dataset is edge-case-only regardless of structural soundness.
    const components: ComponentFlat[] = [
      { id: 'r1', dependencies: ['a', 'b'] },
      { id: 'r2', dependencies: ['c'] },
      { id: 'a', dependencies: [] },
      { id: 'b', dependencies: [] },
      { id: 'c', dependencies: [] },
    ];
    const result = validateDataset(components);
    assert.equal(result.classification, 'edge-case-only');
    assert.ok(result.warnings[0].includes('No root declared'));
  });

  it('classifies a multi-root forest (with declared root) as edge-case-only', () => {
    const components: ComponentFlat[] = [
      { id: 'r1', dependencies: ['a', 'b'] },
      { id: 'r2', dependencies: ['c'] },
      { id: 'a', dependencies: [] },
      { id: 'b', dependencies: [] },
      { id: 'c', dependencies: [] },
    ];
    const result = validateDataset(components, { root: 'r1' });
    assert.equal(result.classification, 'edge-case-only');
    // r2 and c are not reachable from r1.
    assert.ok(result.warnings[0].includes('2'), 'two nodes are unreachable');
  });
});
