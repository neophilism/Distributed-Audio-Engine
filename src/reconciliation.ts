import type { IdentityScope, AuthenticatedActor } from './identity.js';
import { requireAccess } from './identity.js';
import type { CommerceStore, Currency } from './commerce.js';
import { commerceDigest, minorUnits, validateCommerceScope, validateCurrency } from './commerce.js';
import { canonicalJson, identifier, integer, invariant } from './validation.js';

export interface SplitAgreement { id: string; revision: number; shares: { payeeId: string; basisPoints: number }[]; authorizationEvidenceRef: string }
export function validateAgreement(agreement: SplitAgreement): void {
  invariant(Object.keys(agreement).sort().join(',') === 'authorizationEvidenceRef,id,revision,shares', 'UNKNOWN_SPLIT_FIELDS');
  identifier(agreement.id); integer(agreement.revision, 1);
  invariant(/^sha256:[0-9a-f]{64}$/.test(agreement.authorizationEvidenceRef), 'MISSING_SPLIT_AUTHORIZATION');
  invariant(agreement.shares.length > 0 && agreement.shares.length <= 64 && new Set(agreement.shares.map(x => x.payeeId)).size === agreement.shares.length, 'INVALID_SPLIT_PAYEES');
  let total = 0;
  for (const share of agreement.shares) {
    invariant(Object.keys(share).sort().join(',') === 'basisPoints,payeeId', 'UNKNOWN_SPLIT_SHARE'); identifier(share.payeeId); integer(share.basisPoints, 1, 10000); total += share.basisPoints;
  }
  invariant(total === 10000, 'UNBALANCED_SPLIT_AGREEMENT');
}
/** Largest remainder allocation, ASCII payee-ID ties. Negative totals expose liabilities. */
export function allocateShares(total: bigint, agreement: SplitAgreement): { payeeId: string; amountMinor: string }[] {
  validateAgreement(agreement); invariant(total >= -(10n ** 30n) + 1n && total < 10n ** 30n, 'ACCOUNTING_AMOUNT_LIMIT');
  const negative = total < 0n, amount = negative ? -total : total;
  const rows = agreement.shares.map(x => ({ payeeId: x.payeeId, amount: amount * BigInt(x.basisPoints) / 10000n, remainder: amount * BigInt(x.basisPoints) % 10000n }));
  let remaining = amount - rows.reduce((sum, x) => sum + x.amount, 0n);
  rows.sort((a, b) => a.remainder === b.remainder ? a.payeeId < b.payeeId ? -1 : a.payeeId > b.payeeId ? 1 : 0 : a.remainder > b.remainder ? -1 : 1);
  for (const row of rows) if (remaining > 0n) { row.amount++; remaining--; }
  return rows.sort((a, b) => a.payeeId < b.payeeId ? -1 : a.payeeId > b.payeeId ? 1 : 0).map(x => ({ payeeId: x.payeeId, amountMinor: String(negative ? -x.amount : x.amount) }));
}
export interface TransferReservation {
  id: string; checkoutId: string; payeeId: string; currency: Currency; amountMinor: string; reservedAtMs: number;
  idempotencyKeyHex: string; status: 'pending' | 'succeeded' | 'failed';
}
export interface ReconciliationAccount {
  checkoutId: string; providerPaymentId: string; currency: Currency; grossMinor: string; feeMinor: string;
  refundedGrossMinor: string; refundedFeeMinor: string; capturedAtMs: number; agreement: SplitAgreement;
}
export interface AccountingState {
  agreements: Map<string, SplitAgreement>; accounts: Map<string, ReconciliationAccount>;
  transfers: Map<string, TransferReservation>; events: Map<string, string>;
}
export interface AccountingStore { transact<T>(scope: IdentityScope, operation: (state: AccountingState) => T): T }
export class MemoryAccountingStore implements AccountingStore {
  private readonly values = new Map<string, AccountingState>(); private busy = false;
  transact<T>(scope: IdentityScope, operation: (state: AccountingState) => T): T {
    validateCommerceScope(scope); invariant(!this.busy, 'ACCOUNTING_REENTRANT_TRANSACTION'); this.busy = true;
    try {
      const key = canonicalJson(scope), draft = structuredClone(this.values.get(key) ?? { agreements: new Map(), accounts: new Map(), transfers: new Map(), events: new Map() });
      const result = operation(draft); invariant(!(result && typeof result === 'object' && 'then' in result), 'ASYNC_ACCOUNTING_TRANSACTION');
      invariant(draft.agreements.size <= 1024 && draft.accounts.size <= 4096 && draft.transfers.size <= 16384 && draft.events.size <= 32768, 'ACCOUNTING_STORE_LIMIT');
      const snapshotResult = structuredClone(result); this.values.set(key, structuredClone(draft)); return snapshotResult;
    } finally { this.busy = false; }
  }
}
interface AccountingEventBase { scope: IdentityScope; eventId: string; providerId: string; merchantAccountId: string; checkoutId: string; providerPaymentId: string; currency: Currency; occurredAtMs: number }
export type AccountingEvent = AccountingEventBase & (
  { kind: 'capture'; grossMinor: string; feeMinor: string; agreementId: string; agreementRevision: number } |
  { kind: 'refund'; refundedGrossMinor: string; refundedFeeMinor: string } |
  { kind: 'transfer'; transferId: string; payeeId: string; amountMinor: string; status: 'succeeded' | 'failed' }
);
/** Adapter verifies raw provider signatures and maps confirmed financial facts, never browser claims. */
export interface AccountingEventVerifier { verify(raw: Uint8Array<ArrayBuffer>, authentication: string, nowMs: number): Promise<AccountingEvent> }
export interface ReconciliationStatement {
  checkoutId: string; currency: Currency; grossMinor: string; retainedFeeMinor: string; refundedGrossMinor: string;
  obligations: { payeeId: string; targetMinor: string; transferredMinor: string; reservedMinor: string; balanceMinor: string }[];
  failedTransferIds: string[]; balanced: true;
}
export function accountStatement(account: ReconciliationAccount, transfers: readonly TransferReservation[]): ReconciliationStatement {
  const gross = minorUnits(account.grossMinor), fee = minorUnits(account.feeMinor), refunded = minorUnits(account.refundedGrossMinor), refundedFee = minorUnits(account.refundedFeeMinor);
  invariant(fee <= gross && refunded <= gross && refundedFee <= fee && refundedFee <= refunded, 'INVALID_ACCOUNT_TOTALS');
  const net = gross - fee - refunded + refundedFee;
  const obligations = allocateShares(net, account.agreement).map(row => {
    const own = transfers.filter(x => x.checkoutId === account.checkoutId && x.payeeId === row.payeeId);
    const transferred = own.filter(x => x.status === 'succeeded').reduce((sum, x) => sum + minorUnits(x.amountMinor), 0n);
    const reserved = own.filter(x => x.status === 'pending').reduce((sum, x) => sum + minorUnits(x.amountMinor), 0n);
    return { payeeId: row.payeeId, targetMinor: row.amountMinor, transferredMinor: String(transferred), reservedMinor: String(reserved), balanceMinor: String(BigInt(row.amountMinor) - transferred - reserved) };
  });
  invariant(refunded + fee - refundedFee + obligations.reduce((sum, x) => sum + BigInt(x.targetMinor), 0n) === gross, 'UNBALANCED_ACCOUNTING');
  return { checkoutId: account.checkoutId, currency: structuredClone(account.currency), grossMinor: account.grossMinor, retainedFeeMinor: String(fee - refundedFee), refundedGrossMinor: account.refundedGrossMinor, obligations,
    failedTransferIds: transfers.filter(x => x.checkoutId === account.checkoutId && x.status === 'failed').map(x => x.id).sort(), balanced: true };
}
export class ReconciliationEngine {
  private readonly scope: IdentityScope;
  constructor(scope: IdentityScope, private readonly providerId: string, private readonly merchantAccountId: string, private readonly checkouts: CommerceStore, private readonly store: AccountingStore, private readonly verifier: AccountingEventVerifier) {
    validateCommerceScope(scope); this.scope = structuredClone(scope); identifier(providerId); identifier(merchantAccountId);
  }
  registerAgreement(actor: AuthenticatedActor, agreement: SplitAgreement, nowMs: number): void {
    requireAccess(actor, this.scope, 'commerce:manage', nowMs); const value = structuredClone(agreement); validateAgreement(value);
    this.store.transact(this.scope, state => { const key = `${value.id}:${value.revision}`; invariant(!state.agreements.has(key), 'SPLIT_AGREEMENT_ID_REUSE'); state.agreements.set(key, value); });
  }
  statement(actor: AuthenticatedActor, checkoutId: string, nowMs: number): ReconciliationStatement {
    requireAccess(actor, this.scope, 'commerce:manage', nowMs); identifier(checkoutId);
    return this.store.transact(this.scope, state => { const account = state.accounts.get(checkoutId); invariant(account, 'UNKNOWN_ACCOUNT'); return accountStatement(account, [...state.transfers.values()]); });
  }
  async accept(raw: Uint8Array<ArrayBuffer>, authentication: string, nowMs: number): Promise<ReconciliationStatement> {
    integer(nowMs); invariant(raw instanceof Uint8Array && raw.byteLength > 0 && raw.byteLength <= 65536 && typeof authentication === 'string' && authentication.length > 0 && authentication.length <= 4096, 'INVALID_ACCOUNTING_WEBHOOK');
    const event = structuredClone(await this.verifier.verify(raw.slice(), authentication, nowMs));
    const base = 'checkoutId,currency,eventId,kind,merchantAccountId,occurredAtMs,providerId,providerPaymentId,scope';
    const extra = event.kind === 'capture' ? ',agreementId,agreementRevision,feeMinor,grossMinor' : event.kind === 'refund' ? ',refundedFeeMinor,refundedGrossMinor' : ',amountMinor,payeeId,status,transferId';
    invariant(Object.keys(event).sort().join(',') === (base + extra).split(',').sort().join(','), 'UNKNOWN_ACCOUNTING_FIELDS');
    validateCommerceScope(event.scope); validateCurrency(event.currency); integer(event.occurredAtMs);
    for (const id of [event.eventId, event.checkoutId, event.providerPaymentId]) identifier(id);
    invariant(canonicalJson(event.scope) === canonicalJson(this.scope) && event.providerId === this.providerId && event.merchantAccountId === this.merchantAccountId, 'ACCOUNTING_SCOPE_MISMATCH');
    invariant(event.occurredAtMs <= nowMs && nowMs - event.occurredAtMs <= 604_800_000, 'ACCOUNTING_EVENT_STALE_OR_FUTURE');
    const digest = await commerceDigest({ domain: 'DAE-ACCOUNTING-EVENT-v1', event });
    const order = this.checkouts.transact(this.scope, state => state.orders.get(event.checkoutId));
    invariant(order?.status === 'settled' && order.providerId === this.providerId && order.merchantAccountId === this.merchantAccountId && order.providerPaymentId === event.providerPaymentId && canonicalJson(order.currency) === canonicalJson(event.currency), 'ACCOUNTING_CHECKOUT_MISMATCH');
    invariant(order.settledAtMs !== null && event.occurredAtMs >= order.settledAtMs, 'ACCOUNTING_BEFORE_SETTLEMENT');
    return this.store.transact(this.scope, state => {
      const seen = state.events.get(event.eventId); invariant(!seen || seen === digest, 'ACCOUNTING_EVENT_ID_CONFLICT');
      if (!seen) {
        if (event.kind === 'capture') {
          identifier(event.agreementId); integer(event.agreementRevision, 1); const agreement = state.agreements.get(`${event.agreementId}:${event.agreementRevision}`);
          invariant(agreement && !state.accounts.has(event.checkoutId), 'CAPTURE_OR_AGREEMENT_CONFLICT');
          invariant(event.grossMinor === order.amountMinor && minorUnits(event.feeMinor) <= minorUnits(event.grossMinor), 'CAPTURE_AMOUNT_MISMATCH');
          state.accounts.set(event.checkoutId, { checkoutId: event.checkoutId, providerPaymentId: event.providerPaymentId, currency: event.currency, grossMinor: event.grossMinor, feeMinor: event.feeMinor, refundedGrossMinor: '0', refundedFeeMinor: '0', capturedAtMs: event.occurredAtMs, agreement: structuredClone(agreement) });
        } else {
          const account = state.accounts.get(event.checkoutId); invariant(account && event.occurredAtMs >= account.capturedAtMs, 'UNKNOWN_OR_FUTURE_ACCOUNT');
          if (event.kind === 'refund') {
            const gross = minorUnits(event.refundedGrossMinor), fee = minorUnits(event.refundedFeeMinor); invariant(gross > 0n && fee <= gross, 'INVALID_REFUND');
            const refundTotal = minorUnits(account.refundedGrossMinor) + gross, feeTotal = minorUnits(account.refundedFeeMinor) + fee;
            invariant(refundTotal <= minorUnits(account.grossMinor) && feeTotal <= minorUnits(account.feeMinor), 'REFUND_EXCEEDS_CAPTURE');
            account.refundedGrossMinor = String(refundTotal); account.refundedFeeMinor = String(feeTotal);
          } else {
            invariant(event.kind === 'transfer' && (event.status === 'succeeded' || event.status === 'failed'), 'INVALID_TRANSFER_EVENT');
            identifier(event.transferId); identifier(event.payeeId); minorUnits(event.amountMinor);
            const transfer = state.transfers.get(event.transferId);
            invariant(transfer && transfer.checkoutId === event.checkoutId && transfer.payeeId === event.payeeId && transfer.amountMinor === event.amountMinor && event.occurredAtMs >= transfer.reservedAtMs && transfer.status === 'pending', 'TRANSFER_EVENT_MISMATCH'); transfer.status = event.status;
          }
        }
        state.events.set(event.eventId, digest);
      }
      const account = state.accounts.get(event.checkoutId); invariant(account, 'UNKNOWN_ACCOUNT'); return accountStatement(account, [...state.transfers.values()]);
    });
  }
  /** Reserve before dispatch. Timeouts remain pending until confirmed provider facts resolve them. */
  async reserveTransfer(actor: AuthenticatedActor, checkoutId: string, transferId: string, payeeId: string, amountMinor: string, nowMs: number): Promise<TransferReservation> {
    actor = structuredClone(actor); requireAccess(actor, this.scope, 'commerce:manage', nowMs);
    identifier(checkoutId); identifier(transferId); identifier(payeeId); const amount = minorUnits(amountMinor); invariant(amount > 0n, 'ZERO_TRANSFER');
    const key = await commerceDigest({ domain: 'DAE-TRANSFER-v1', scope: this.scope, providerId: this.providerId, merchantAccountId: this.merchantAccountId, transferId });
    return this.store.transact(this.scope, state => {
      const existing = state.transfers.get(transferId);
      if (existing) { invariant(existing.checkoutId === checkoutId && existing.payeeId === payeeId && existing.amountMinor === amountMinor, 'TRANSFER_ID_CONFLICT'); return existing; }
      const account = state.accounts.get(checkoutId); invariant(account, 'UNKNOWN_ACCOUNT'); integer(nowMs, account.capturedAtMs);
      const statement = accountStatement(account, [...state.transfers.values()]), balance = statement.obligations.find(x => x.payeeId === payeeId);
      invariant(balance && BigInt(balance.balanceMinor) >= amount, 'TRANSFER_EXCEEDS_BALANCE');
      const transfer: TransferReservation = { id: transferId, checkoutId, payeeId, currency: structuredClone(account.currency), amountMinor, reservedAtMs: nowMs, idempotencyKeyHex: key, status: 'pending' };
      state.transfers.set(transferId, transfer); return transfer;
    });
  }
}
