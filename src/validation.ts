export class ContractError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ContractError'; }
}
export function invariant(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ContractError(code);
}
export function identifier(value: unknown): asserts value is string {
  invariant(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value), 'INVALID_IDENTIFIER');
}
export function finite(value: number, min = -Infinity, max = Infinity): void {
  invariant(Number.isFinite(value) && value >= min && value <= max, 'INVALID_NUMBER');
}
export function integer(value: number, min = 0, max = Number.MAX_SAFE_INTEGER): void {
  invariant(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_INTEGER');
}
/** Local v1 contract: RFC 8785 bytes on a bounded, safe-integer subset. */
export const CANONICAL_JSON_CONTRACT = 'DAE-JSON-v1' as const;
const MAX_JSON_BYTES = 1_048_576, MAX_JSON_DEPTH = 64, MAX_JSON_NODES = 100_000;
function unicode(value: string): void {
  invariant(value.length <= MAX_JSON_BYTES, 'CANONICAL_SIZE_LIMIT');
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index); invariant(next >= 0xdc00 && next <= 0xdfff, 'INVALID_UNICODE');
    } else invariant(unit < 0xdc00 || unit > 0xdfff, 'INVALID_UNICODE');
  }
}
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>(); let nodes = 0, characters = 0;
  const account = (text: string): string => {
    characters += text.length; invariant(characters <= MAX_JSON_BYTES, 'CANONICAL_SIZE_LIMIT'); return text;
  };
  const visit = (input: unknown, depth: number): string => {
    invariant(++nodes <= MAX_JSON_NODES && depth <= MAX_JSON_DEPTH, 'CANONICAL_COMPLEXITY_LIMIT');
    if (input === null || typeof input === 'boolean') return account(JSON.stringify(input));
    if (typeof input === 'string') { unicode(input); return account(JSON.stringify(input)); }
    if (typeof input === 'number') {
      finite(input); invariant(!Number.isInteger(input) || Number.isSafeInteger(input), 'UNSAFE_CANONICAL_INTEGER');
      return account(JSON.stringify(input));
    }
    invariant(typeof input === 'object' && input !== null, 'INVALID_CANONICAL_VALUE');
    invariant(!seen.has(input), 'CYCLIC_VALUE'); seen.add(input);
    const keys = Object.keys(input); invariant(keys.length <= MAX_JSON_NODES, 'CANONICAL_COMPLEXITY_LIMIT');
    const descriptors = Object.getOwnPropertyDescriptors(input);
    invariant(Reflect.ownKeys(input).every(key => typeof key === 'string'), 'CANONICAL_SYMBOL');
    invariant(Object.values(descriptors).every(d => !d.get && !d.set), 'CANONICAL_ACCESSOR');
    let result: string;
    if (Array.isArray(input)) {
      invariant(keys.length === input.length && keys.every((key, index) => key === String(index)) && Object.keys(descriptors).length === keys.length + 1, 'NON_CANONICAL_ARRAY');
      account('[]' + ','.repeat(Math.max(0, keys.length - 1)));
      result = '[' + keys.map(key => visit(descriptors[key]!.value, depth + 1)).join(',') + ']';
    } else {
      invariant(Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null, 'NON_PLAIN_OBJECT');
      invariant(keys.length === Object.keys(descriptors).length, 'NON_ENUMERABLE_CANONICAL_FIELD');
      account('{}' + ','.repeat(Math.max(0, keys.length - 1)));
      result = '{' + keys.sort().map(key => { unicode(key); return account(JSON.stringify(key) + ':') + visit(descriptors[key]!.value, depth + 1); }).join(',') + '}';
    }
    seen.delete(input); return result;
  };
  const result = visit(value, 0);
  invariant(new TextEncoder().encode(result).byteLength <= MAX_JSON_BYTES, 'CANONICAL_SIZE_LIMIT'); return result;
}
/** Parse untrusted JSON before hashing; JSON.parse alone loses duplicate members. */
export function parseCanonicalJson(text: string): unknown {
  invariant(typeof text === 'string' && text.length <= MAX_JSON_BYTES && new TextEncoder().encode(text).byteLength <= MAX_JSON_BYTES, 'CANONICAL_SIZE_LIMIT');
  let offset = 0, nodes = 0;
  const whitespace = (): void => { while (offset < text.length && /[\t\n\r ]/.test(text[offset]!)) offset++; };
  const string = (): string => {
    invariant(text[offset] === '"', 'INVALID_JSON'); const start = offset++;
    while (offset < text.length) {
      const char = text[offset++]!;
      if (char === '"') { const value: unknown = JSON.parse(text.slice(start, offset)); invariant(typeof value === 'string', 'INVALID_JSON'); unicode(value); return value; }
      if (char === '\\') offset++; // JSON.parse checks escape syntax and controls.
    }
    throw new ContractError('INVALID_JSON');
  };
  const value = (depth: number): unknown => {
    invariant(++nodes <= MAX_JSON_NODES && depth <= MAX_JSON_DEPTH, 'CANONICAL_COMPLEXITY_LIMIT'); whitespace();
    const char = text[offset];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      offset++; whitespace(); const object = char === '{', end = object ? '}' : ']';
      const record: Record<string, unknown> = Object.create(null); const array: unknown[] = []; const keys = new Set<string>();
      if (text[offset] === end) { offset++; return object ? record : array; }
      for (;;) {
        if (object) {
          whitespace(); const key = string(); invariant(!keys.has(key), 'DUPLICATE_JSON_MEMBER'); keys.add(key);
          whitespace(); invariant(text[offset++] === ':', 'INVALID_JSON'); record[key] = value(depth + 1);
        } else array.push(value(depth + 1));
        whitespace(); if (text[offset] === end) { offset++; break; }
        invariant(text[offset++] === ',', 'INVALID_JSON');
      }
      return object ? record : array;
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(offset));
    invariant(match, 'INVALID_JSON'); offset += match[0].length;
    return JSON.parse(match[0]);
  };
  const parsed = value(0); whitespace(); invariant(offset === text.length, 'INVALID_JSON'); canonicalJson(parsed); return parsed;
}
