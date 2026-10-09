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
/** Restricted canonical JSON: finite numbers, plain objects, no undefined or cycles. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const visit = (input: unknown): string => {
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return JSON.stringify(input);
    if (typeof input === 'number') { finite(input); return JSON.stringify(input); }
    invariant(typeof input === 'object' && input !== null, 'INVALID_CANONICAL_VALUE');
    invariant(!seen.has(input), 'CYCLIC_VALUE');
    seen.add(input);
    let result: string;
    if (Array.isArray(input)) result = '[' + input.map(visit).join(',') + ']';
    else {
      invariant(Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null, 'NON_PLAIN_OBJECT');
      result = '{' + Object.keys(input).sort().map(key => JSON.stringify(key) + ':' + visit((input as Record<string, unknown>)[key])).join(',') + '}';
    }
    seen.delete(input);
    return result;
  };
  return visit(value);
}
