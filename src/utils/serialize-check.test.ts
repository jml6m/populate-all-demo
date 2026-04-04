import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ComponentPopulated } from '../algorithms/types';
import { serializeCheck } from './serialize-check';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string): ComponentPopulated {
  return { id, dependencies: [] };
}

// ---------------------------------------------------------------------------
// Acyclic values — JSON.stringify succeeds
// ---------------------------------------------------------------------------

describe('serializeCheck — acyclic values pass', () => {
  it('passes for null', () => {
    const r = serializeCheck(null);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('passes for a plain number', () => {
    const r = serializeCheck(42);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('passes for an empty array', () => {
    const r = serializeCheck([]);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('passes for an acyclic node array (no dependencies)', () => {
    const a = makeNode('a');
    const b = makeNode('b');
    const r = serializeCheck([a, b]);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('passes for a simple linear graph (a → b)', () => {
    const a = makeNode('a');
    const b = makeNode('b');
    a.dependencies.push(b);
    const r = serializeCheck([a, b]);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('passes for a diamond graph with shared reference (acyclic)', () => {
    const a = makeNode('a');
    const b = makeNode('b');
    const c = makeNode('c');
    const d = makeNode('d');
    a.dependencies.push(b, c);
    b.dependencies.push(d);
    c.dependencies.push(d); // shared reference — acyclic but shared
    // JSON.stringify will serialize d twice (no circular reference), so it passes
    const r = serializeCheck([a]);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });
});

// ---------------------------------------------------------------------------
// Cyclic values — JSON.stringify throws, serializeCheck returns FAIL
// ---------------------------------------------------------------------------

describe('serializeCheck — cyclic values fail', () => {
  it('fails for a 2-node cycle (a → b → a)', () => {
    const a = makeNode('a');
    const b = makeNode('b');
    a.dependencies.push(b);
    b.dependencies.push(a); // cycle
    const r = serializeCheck([a, b]);
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null);
    assert.ok(
      r.errorDetail.toLowerCase().includes('circular') || r.errorDetail.toLowerCase().includes('cyclic'),
      `Expected circular/cyclic in errorDetail, got: ${r.errorDetail}`,
    );
  });

  it('fails for a self-loop (a → a)', () => {
    const a = makeNode('a');
    a.dependencies.push(a); // self-loop
    const r = serializeCheck([a]);
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null);
  });

  it('fails for a 3-node cycle (a → b → c → a)', () => {
    const a = makeNode('a');
    const b = makeNode('b');
    const c = makeNode('c');
    a.dependencies.push(b);
    b.dependencies.push(c);
    c.dependencies.push(a); // cycle back to a
    const r = serializeCheck([a, b, c]);
    assert.equal(r.pass, false);
    assert.ok(r.errorDetail !== null);
  });

  it('errorDetail is a non-empty string on failure', () => {
    const a = makeNode('a');
    a.dependencies.push(a);
    const r = serializeCheck([a]);
    assert.equal(r.pass, false);
    assert.ok(typeof r.errorDetail === 'string' && r.errorDetail.length > 0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('serializeCheck — edge cases', () => {
  it('passes for an empty object {}', () => {
    const r = serializeCheck({});
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });

  it('passes for undefined (JSON.stringify returns undefined, does not throw)', () => {
    // JSON.stringify(undefined) returns undefined (not a string), but does NOT throw
    const r = serializeCheck(undefined);
    assert.equal(r.pass, true);
    assert.equal(r.errorDetail, null);
  });
});
