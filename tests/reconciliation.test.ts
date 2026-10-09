import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutEngine, MemoryCommerceStore, MemoryAccountingStore, ReconciliationEngine, allocateShares } from '../src/index.js';
import type { AccountingEvent, AccountingEventVerifier, SplitAgreement, IdentityScope, AuthenticatedActor } from '../src/index.js';
import { commerceFixture } from './helpers/commerce.js';
const scope: IdentityScope = { tenantId: 'tenant', application: 'distributed-radio', identityId: 'merchant' };
const manager: AuthenticatedActor = { ...scope, deviceId: 'device', expiresAtMs: 100_000, permissions: ['commerce:manage'] };
const buyer: AuthenticatedActor = { ...manager, identityId: 'buyer', permissions: ['commerce:buy'] };
const agreement: SplitAgreement = { id: 'agreement', revision: 1, shares: [{ payeeId: 'a', basisPoints: 3333 }, { payeeId: 'b', basisPoints: 3333 }, { payeeId: 'c', basisPoints: 3334 }], authorizationEvidenceRef: 'sha256:' + 'b'.repeat(64) };
const raw = new Uint8Array([1]);
async function fixture() {
  const checkouts = new MemoryCommerceStore(), f = commerceFixture(checkouts);
  // Register a small exact quote, so rounding/liabilities are easy to inspect.
  f.engine.registerProduct({ ...manager, permissions: ['commerce:manage'] }, { id: 'small', revision: 1, assets: [{ assetId: 'one', rightsLayers: ['recording'] }], priceMinor: '100', currency: { code: 'USD', minorUnit: 2 }, validUntilMs: 100_000 }, 1);
  const order = await f.engine.createCheckout(buyer, { checkoutId: 'checkout', productId: 'small', productRevision: 1, territory: 'US' }, 100);
  f.setEvent({ scope, eventId: 'settlement', providerId: 'provider', merchantAccountId: 'account', checkoutId: 'checkout', buyerId: 'buyer', productDigestHex: order.productDigestHex, providerPaymentId: 'payment', currency: order.currency, amountMinor: '100', occurredAtMs: 200, status: 'settled' });
  await f.engine.settle(raw, 'signed', 300);
  let event: AccountingEvent = { scope, eventId: 'capture', providerId: 'provider', merchantAccountId: 'account', checkoutId: 'checkout', providerPaymentId: 'payment', currency: order.currency, occurredAtMs: 300, kind: 'capture', grossMinor: '100', feeMinor: '7', agreementId: 'agreement', agreementRevision: 1 };
  let verified = true; const verifier: AccountingEventVerifier = { async verify() { assert.ok(verified, 'signature failed'); return structuredClone(event); } };
  const store = new MemoryAccountingStore(), engine = new ReconciliationEngine(scope, 'provider', 'account', checkouts, store, verifier);
  engine.registerAgreement(manager, agreement, 100); await engine.accept(raw, 'signed', 400);
  return { engine, store, checkouts, capture: structuredClone(event), setEvent(value: AccountingEvent) { event = value; }, setVerified(value: boolean) { verified = value; } };
}
function refund(base: AccountingEvent, id: string, amount: string, fee: string): AccountingEvent {
  return { scope: base.scope, providerId: base.providerId, merchantAccountId: base.merchantAccountId, checkoutId: base.checkoutId, providerPaymentId: base.providerPaymentId, currency: base.currency, occurredAtMs: 500, eventId: id, kind: 'refund', refundedGrossMinor: amount, refundedFeeMinor: fee };
}
test('allocation balances all small and very large totals independently of input order', () => {
  for (const amount of [...Array.from({ length: 301 }, (_, i) => BigInt(i)), 999999999999999999999999999999n, -7n]) {
    const rows = allocateShares(amount, agreement); assert.equal(rows.reduce((sum, x) => sum + BigInt(x.amountMinor), 0n), amount);
    assert.deepEqual(rows, allocateShares(amount, { ...agreement, shares: [...agreement.shares].reverse() }));
    for (const row of rows) { const basis = agreement.shares.find(x => x.payeeId === row.payeeId)!.basisPoints; const delta = BigInt(row.amountMinor) * 10000n - amount * BigInt(basis); assert.ok(delta > -10000n && delta < 10000n); }
  }
  assert.throws(() => allocateShares(1n, { ...agreement, shares: [{ payeeId: 'a', basisPoints: 9999 }] }));
});
test('capture fees and cumulative partial refunds reconcile without fragmentation windfalls', async () => {
  const left = await fixture(), right = await fixture();
  left.setEvent(refund(left.capture, 'r1', '20', '1')); await left.engine.accept(raw, 'signed', 600);
  left.setEvent(refund(left.capture, 'r2', '30', '2')); const partial = await left.engine.accept(raw, 'signed', 600);
  right.setEvent(refund(right.capture, 'r', '50', '3')); const single = await right.engine.accept(raw, 'signed', 600);
  assert.deepEqual(partial.obligations, single.obligations); assert.equal(partial.retainedFeeMinor, '4'); assert.equal(partial.refundedGrossMinor, '50');
  assert.equal(partial.obligations.reduce((sum, x) => sum + BigInt(x.targetMinor), 0n), 46n);
  assert.deepEqual(await left.engine.accept(raw, 'signed', 600), partial);
  left.setEvent(refund(left.capture, 'too-much', '51', '0')); await assert.rejects(left.engine.accept(raw, 'signed', 600), /REFUND_EXCEEDS_CAPTURE/);
  assert.equal(left.engine.statement(manager, 'checkout', 600).refundedGrossMinor, '50');
});
test('full refunds with retained provider fees expose signed liabilities', async () => {
  const f = await fixture(); f.setEvent(refund(f.capture, 'full', '100', '0')); const statement = await f.engine.accept(raw, 'signed', 600);
  assert.equal(statement.obligations.reduce((sum, x) => sum + BigInt(x.balanceMinor), 0n), -7n); assert.equal(statement.balanced, true);
  await assert.rejects(f.engine.reserveTransfer(manager, 'checkout', 'transfer', 'a', '1', 700), /TRANSFER_EXCEEDS_BALANCE/);
});
test('concurrent transfer reservations prevent overspending and uncertain dispatch stays pending', async () => {
  const f = await fixture(); const results = await Promise.allSettled([f.engine.reserveTransfer(manager, 'checkout', 't1', 'a', '20', 500), f.engine.reserveTransfer(manager, 'checkout', 't2', 'a', '20', 500)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  const first = await f.engine.reserveTransfer(manager, 'checkout', 't1', 'a', '20', 600); assert.equal(first.status, 'pending');
  assert.equal(f.engine.statement(manager, 'checkout', 600).obligations[0]!.reservedMinor, '20');
  await assert.rejects(f.engine.reserveTransfer(manager, 'checkout', 't1', 'b', '20', 600), /TRANSFER_ID_CONFLICT/);
});
test('confirmed transfer failure is visible, and success reduces the available balance once', async () => {
  const f = await fixture(); await f.engine.reserveTransfer(manager, 'checkout', 't1', 'a', '20', 500);
  const base = f.capture; const event: AccountingEvent = { scope, eventId: 'failure', providerId: base.providerId, merchantAccountId: base.merchantAccountId, checkoutId: base.checkoutId, providerPaymentId: base.providerPaymentId, currency: base.currency, occurredAtMs: 600, kind: 'transfer', transferId: 't1', payeeId: 'a', amountMinor: '20', status: 'failed' };
  f.setEvent(event); const failure = await f.engine.accept(raw, 'signed', 700); assert.deepEqual(failure.failedTransferIds, ['t1']); assert.equal(failure.obligations[0]!.reservedMinor, '0');
  await f.engine.reserveTransfer(manager, 'checkout', 't2', 'a', '20', 700); f.setEvent({ ...event, transferId: 't2', eventId: 'success', status: 'succeeded', occurredAtMs: 800 });
  const success = await f.engine.accept(raw, 'signed', 900); assert.equal(success.obligations[0]!.transferredMinor, '20'); assert.equal(success.obligations[0]!.balanceMinor, '11');
  assert.deepEqual(await f.engine.accept(raw, 'signed', 900), success);
});
test('accounting rejects forgery, changed events and cross-scope or unsettled captures', async () => {
  const f = await fixture(); f.setVerified(false); await assert.rejects(f.engine.accept(raw, 'forged', 400)); f.setVerified(true);
  f.setEvent({ ...f.capture, feeMinor: '8' } as AccountingEvent); await assert.rejects(f.engine.accept(raw, 'signed', 400), /ACCOUNTING_EVENT_ID_CONFLICT/);
  f.setEvent({ ...f.capture, eventId: 'other', scope: { ...scope, tenantId: 'other' } }); await assert.rejects(f.engine.accept(raw, 'signed', 400), /ACCOUNTING_SCOPE_MISMATCH/);
  f.setEvent({ ...f.capture, eventId: 'other', checkoutId: 'missing' }); await assert.rejects(f.engine.accept(raw, 'signed', 400), /ACCOUNTING_CHECKOUT_MISMATCH/);
  assert.throws(() => f.engine.statement(buyer, 'checkout', 400));
  assert.throws(() => f.engine.registerAgreement(manager, agreement, 400), /SPLIT_AGREEMENT_ID_REUSE/);
});
