import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, identifier, integer, finite } from '../src/index.js';
test('canonical encoding is stable for reordered nested objects', () => {
  assert.equal(canonicalJson({b: [3, {z: 1, a: 2}], a: 'x'}), canonicalJson({a: 'x', b: [3, {a: 2, z: 1}]}));
});
test('canonical encoding rejects values with ambiguous or lossy encodings', () => {
  const cycle: Record<string, unknown> = {}; cycle['self'] = cycle;
  for (const value of [NaN, Infinity, undefined, {a: undefined}, new Date(), cycle, () => 1]) assert.throws(() => canonicalJson(value));
});
test('contract validators reject non-finite numbers, unsafe integers and path identifiers', () => {
  for (const id of ['', '../secret', 'abc/def', 'a'.repeat(129)]) assert.throws(() => identifier(id));
  for (const value of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => integer(value));
  assert.throws(() => finite(NaN));
  identifier('device:123'); integer(1);
});
