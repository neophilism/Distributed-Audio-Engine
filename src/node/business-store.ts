import { DatabaseSync } from 'node:sqlite';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { IdentityScope } from '../identity.js';
import type { CommerceStore, CommerceState, CheckoutOrder } from '../commerce.js';
import { minorUnits, validateCommerceScope, validateCurrency } from '../commerce.js';
import type { AccountingStore, AccountingState, ReconciliationAccount, TransferReservation, SplitAgreement } from '../reconciliation.js';
import { accountStatement, validateAgreement } from '../reconciliation.js';
import { canonicalJson, identifier, integer, invariant, parseCanonicalJson } from '../validation.js';

function exact(value: object, fields: string): void { invariant(value && typeof value === 'object' && Object.keys(value).sort().join(',') === fields.split(',').sort().join(','), 'INVALID_BUSINESS_RECORD'); }
function digest(value: string): void { invariant(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'INVALID_BUSINESS_DIGEST'); }
function currencyMatch(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function order(value: CheckoutOrder, scope: IdentityScope): void {
  exact(value, 'scope,checkoutId,buyerId,productId,productRevision,productDigestHex,territory,currency,amountMinor,createdAtMs,expiresAtMs,providerId,merchantAccountId,providerPaymentId,status,settlementEventId,settledAtMs');
  validateCommerceScope(value.scope); invariant(canonicalJson(value.scope) === canonicalJson(scope), 'BUSINESS_SCOPE_MISMATCH');
  for (const id of [value.checkoutId, value.buyerId, value.productId, value.providerId, value.merchantAccountId]) identifier(id);
  integer(value.productRevision, 1); digest(value.productDigestHex); validateCurrency(value.currency); invariant(minorUnits(value.amountMinor) > 0n, 'INVALID_BUSINESS_AMOUNT');
  invariant(/^[A-Z]{2}$/.test(value.territory), 'INVALID_TERRITORY'); integer(value.createdAtMs); integer(value.expiresAtMs, value.createdAtMs + 1);
  invariant(['reserved', 'pending', 'settled'].includes(value.status), 'INVALID_BUSINESS_STATE');
  if (value.status === 'reserved') invariant(value.providerPaymentId === null, 'INVALID_BUSINESS_STATE'); else identifier(value.providerPaymentId);
  if (value.status === 'settled') { identifier(value.settlementEventId); integer(value.settledAtMs!, value.createdAtMs, value.expiresAtMs - 1); }
  else invariant(value.settlementEventId === null && value.settledAtMs === null, 'INVALID_BUSINESS_STATE');
}
function validateCommerce(state: CommerceState, scope: IdentityScope): void {
  invariant(state.orders.size <= 4096 && state.events.size <= 16384 && state.payments.size <= 4096, 'COMMERCE_STORE_LIMIT');
  for (const [id, value] of state.orders) { order(value, scope); invariant(id === value.checkoutId, 'BUSINESS_RECORD_ID_MISMATCH'); }
  for (const [id, value] of state.events) { identifier(id); exact(value, 'digestHex,checkoutId'); digest(value.digestHex); invariant(state.orders.get(value.checkoutId)?.status === 'settled', 'ORPHAN_PAYMENT_EVENT'); }
  for (const [id, owner] of state.payments) { identifier(id); identifier(owner); invariant(state.orders.get(owner)?.providerPaymentId === id, 'ORPHAN_PAYMENT_ID'); }
  for (const value of state.orders.values()) if (value.providerPaymentId !== null) invariant(state.payments.get(value.providerPaymentId) === value.checkoutId, 'MISSING_PAYMENT_ID');
}
function validateAccounting(state: AccountingState): void {
  invariant(state.agreements.size <= 1024 && state.accounts.size <= 4096 && state.transfers.size <= 16384 && state.events.size <= 32768, 'ACCOUNTING_STORE_LIMIT');
  for (const [id, value] of state.agreements) { validateAgreement(value); invariant(id === `${value.id}:${value.revision}`, 'BUSINESS_RECORD_ID_MISMATCH'); }
  for (const [id, value] of state.accounts) {
    exact(value, 'checkoutId,providerPaymentId,currency,grossMinor,feeMinor,refundedGrossMinor,refundedFeeMinor,capturedAtMs,agreement');
    identifier(value.checkoutId); identifier(value.providerPaymentId); validateCurrency(value.currency); integer(value.capturedAtMs);
    invariant(id === value.checkoutId && canonicalJson(state.agreements.get(`${value.agreement.id}:${value.agreement.revision}`)) === canonicalJson(value.agreement), 'ACCOUNT_AGREEMENT_MISMATCH');
    accountStatement(value, [...state.transfers.values()]);
  }
  for (const [id, value] of state.transfers) {
    exact(value, 'id,checkoutId,payeeId,currency,amountMinor,reservedAtMs,idempotencyKeyHex,status');
    identifier(id); identifier(value.checkoutId); identifier(value.payeeId); validateCurrency(value.currency); digest(value.idempotencyKeyHex);
    const account = state.accounts.get(value.checkoutId); invariant(account && id === value.id && currencyMatch(account.currency, value.currency) && account.agreement.shares.some(x => x.payeeId === value.payeeId), 'ORPHAN_TRANSFER');
    integer(value.reservedAtMs, account.capturedAtMs); invariant(minorUnits(value.amountMinor) > 0n && ['pending', 'succeeded', 'failed'].includes(value.status), 'INVALID_TRANSFER_STATE');
  }
  for (const [id, value] of state.events) { identifier(id); digest(value); }
}
function mapFrom<T>(input: unknown): Map<string, T> {
  invariant(Array.isArray(input) && input.length <= 32768, 'INVALID_BUSINESS_MAP'); const values = new Map<string, T>();
  for (const pair of input) {
    invariant(Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && pair[0].length <= 256 && !values.has(pair[0]), 'INVALID_BUSINESS_MAP');
    values.set(pair[0], pair[1] as T);
  }
  return values;
}
const entries = (map: ReadonlyMap<string, unknown>): [string, unknown][] => [...map].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
function decodeCommerce(input: unknown, scope: IdentityScope): CommerceState {
  invariant(input && typeof input === 'object', 'INVALID_BUSINESS_SNAPSHOT'); exact(input, 'orders,events,payments');
  const v = input as Record<string, unknown>; const state: CommerceState = { orders: mapFrom<CheckoutOrder>(v.orders), events: mapFrom(v.events), payments: mapFrom<string>(v.payments) };
  validateCommerce(state, scope); return state;
}
function decodeAccounting(input: unknown): AccountingState {
  invariant(input && typeof input === 'object', 'INVALID_BUSINESS_SNAPSHOT'); exact(input, 'agreements,accounts,transfers,events');
  const v = input as Record<string, unknown>; const state: AccountingState = { agreements: mapFrom<SplitAgreement>(v.agreements), accounts: mapFrom<ReconciliationAccount>(v.accounts), transfers: mapFrom<TransferReservation>(v.transfers), events: mapFrom<string>(v.events) };
  validateAccounting(state); return state;
}
/** Authorized business endpoint database, not a ciphertext-only relay/cache database. */
class BusinessDatabase {
  private readonly db: DatabaseSync; private closed = false; private busy = false;
  constructor(path: string) {
    invariant(typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0'), 'INVALID_BUSINESS_DATABASE_PATH');
    if (path !== ':memory:') {
      const parent = lstatSync(dirname(resolve(path)));
      invariant(typeof process.getuid === 'function' && parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid() && (parent.mode & 0o077) === 0, 'BUSINESS_DATABASE_REQUIRES_PRIVATE_DIRECTORY');
      const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try { invariant(fstatSync(fd).isFile() && fstatSync(fd).uid === process.getuid(), 'INVALID_BUSINESS_DATABASE_FILE'); fchmodSync(fd, 0o600); } finally { closeSync(fd); }
    }
    this.db = new DatabaseSync(path, { allowExtension: false, enableDoubleQuotedStringLiterals: false });
    try { this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS dae_business_states (domain TEXT NOT NULL, scope_key TEXT NOT NULL, snapshot_json TEXT NOT NULL, PRIMARY KEY (domain, scope_key)) STRICT;`); }
    catch (error) { this.db.close(); throw error; }
  }
  transact<S, T>(domain: string, scope: IdentityScope, empty: () => S, decode: (input: unknown) => S, encode: (state: S) => unknown, operation: (state: S) => T): T {
    invariant(!this.closed && !this.busy, 'BUSINESS_DATABASE_CLOSED_OR_REENTRANT'); validateCommerceScope(scope); const scopeKey = canonicalJson(scope); this.busy = true; let started = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); started = true;
      const row = this.db.prepare('SELECT snapshot_json FROM dae_business_states WHERE domain = ? AND scope_key = ?').get(domain, scopeKey);
      let state = empty();
      if (row) {
        invariant(typeof row.snapshot_json === 'string', 'INVALID_BUSINESS_SNAPSHOT'); const snapshot = parseCanonicalJson(row.snapshot_json) as Record<string, unknown>;
        exact(snapshot, 'version,domain,state'); invariant(snapshot.version === 'DAE-BUSINESS-STATE-v1' && snapshot.domain === domain, 'UNSUPPORTED_BUSINESS_SNAPSHOT'); state = decode(snapshot.state);
      }
      const result = operation(state); invariant(!(result && typeof result === 'object' && 'then' in result), 'ASYNC_BUSINESS_TRANSACTION');
      const encoded = encode(state); decode(encoded); // Validate the exact disclosure whitelist before persisting.
      const payload = canonicalJson({ version: 'DAE-BUSINESS-STATE-v1', domain, state: encoded });
      const snapshotResult = structuredClone(result);
      this.db.prepare('INSERT OR REPLACE INTO dae_business_states VALUES (?, ?, ?)').run(domain, scopeKey, payload);
      this.db.exec('COMMIT'); return snapshotResult;
    } catch (error) { if (started) this.db.exec('ROLLBACK'); throw error; } finally { this.busy = false; }
  }
  close(): void { invariant(!this.busy, 'BUSINESS_TRANSACTION_ACTIVE'); if (!this.closed) { this.db.close(); this.closed = true; } }
}
export class SqliteCommerceStore implements CommerceStore {
  private readonly database: BusinessDatabase;
  constructor(path: string) { this.database = new BusinessDatabase(path); }
  transact<T>(scope: IdentityScope, operation: (state: CommerceState) => T): T {
    scope = structuredClone(scope);
    return this.database.transact('checkout', scope, () => ({ orders: new Map(), events: new Map(), payments: new Map() }), input => decodeCommerce(input, scope), state => ({ orders: entries(state.orders), events: entries(state.events), payments: entries(state.payments) }), operation);
  }
  close(): void { this.database.close(); }
}
export class SqliteAccountingStore implements AccountingStore {
  private readonly database: BusinessDatabase;
  constructor(path: string) { this.database = new BusinessDatabase(path); }
  transact<T>(scope: IdentityScope, operation: (state: AccountingState) => T): T {
    scope = structuredClone(scope);
    return this.database.transact('accounting', scope, () => ({ agreements: new Map(), accounts: new Map(), transfers: new Map(), events: new Map() }), decodeAccounting, state => ({ agreements: entries(state.agreements), accounts: entries(state.accounts), transfers: entries(state.transfers), events: entries(state.events) }), operation);
  }
  close(): void { this.database.close(); }
}
