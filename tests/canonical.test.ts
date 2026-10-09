import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, parseCanonicalJson } from '../src/index.js';

test('v1 bytes retain UTF-16 property ordering, exact Unicode and ordered arrays', () => {
  const value = { '\ufb33': 7, '😀': 6, '€': 5, 'ö': 4, '\u0080': 3, '1': 2, '\r': 1 };
  assert.equal(canonicalJson(value), '{"\\r":1,"1":2,"\u0080":3,"ö":4,"€":5,"😀":6,"דּ":7}');
  assert.equal(canonicalJson({ n: -0, a: [0.002, 1e-27, 'e\u0301', 'é'] }), '{"a":[0.002,1e-27,"é","é"],"n":0}');
  assert.equal(canonicalJson({ b: '測試', a: 'Münster' }), '{"a":"Münster","b":"測試"}');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(canonicalJson({ n: Number.MAX_SAFE_INTEGER }), '{"n":9007199254740991}');
});
test('ambiguous runtime values fail without invoking accessors', () => {
  let called = false; const array = [1]; Object.defineProperty(array, '0', { get() { called = true; return 1; } });
  for (const value of [array, '\ud800', { '\udc00': 1 }, Number.MAX_SAFE_INTEGER + 1, Object.defineProperty({}, 'hidden', { value: 1 }), { [Symbol('x')]: 1 }]) assert.throws(() => canonicalJson(value));
  assert.equal(called, false);
});
test('untrusted JSON rejects duplicate names after escape decoding and malformed inputs', () => {
  for (const text of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"a":{"b":1,"b":2}}', '"\\ud800"', '1e999', '9007199254740993', '[1,]', '{"a":1,}', '01', 'true false', '"unescaped\ncontrol"']) assert.throws(() => parseCanonicalJson(text));
  assert.equal(canonicalJson(parseCanonicalJson(' {"__proto__":{"safe":true}, "a":[false,null,0.1]} ')), '{"__proto__":{"safe":true},"a":[false,null,0.1]}');
  assert.equal(Object.getPrototypeOf(parseCanonicalJson('{"__proto__":1}')), null);
});
test('parse and serialization bound depth and encoded size', () => {
  assert.throws(() => parseCanonicalJson('['.repeat(66) + '0' + ']'.repeat(66)));
  assert.throws(() => canonicalJson('測'.repeat(400_000)));
  assert.throws(() => parseCanonicalJson('"' + 'x'.repeat(1_048_576) + '"'));
});
