import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutEngine, MemoryCommerceStore, RightsCatalog, minorUnits } from '../src/index.js';
import type { SettlementEvent } from '../src/index.js';
import { commerceFixture, scope, manager, buyer, product } from './helpers/commerce.js';
const request = { checkoutId: 'checkout', productId: 'complete', productRevision: 1, territory: 'US' };
const raw = new Uint8Array([1]);
async function prepared(f = commerceFixture()) {
  const order = await f.engine.createCheckout(buyer, request, 100);
  const event: SettlementEvent = { scope, eventId: 'event', providerId: 'provider', merchantAccountId: 'account', checkoutId: order.checkoutId, buyerId: buyer.identityId, productDigestHex: order.productDigestHex, providerPaymentId: 'payment', currency: order.currency, amountMinor: order.amountMinor, occurredAtMs: 200, status: 'settled' };
  f.setEvent(event); return { f, order, event };
}
test('complete-product checkout checks every asset, preserves exact money and retries original quote', async () => {
  const { f, order } = await prepared(); assert.equal(order.status, 'pending'); assert.equal(order.amountMinor, product.priceMinor); assert.equal(f.requests.length, 1);
  assert.deepEqual(await f.engine.createCheckout(buyer, request, 300), order); assert.equal(f.requests.length, 1);
  f.engine.registerProduct(manager, { ...product, revision: 2, priceMinor: '500' }, 400);
  assert.deepEqual(await f.engine.createCheckout(buyer, request, 500), order);
  order.amountMinor = '1'; assert.equal(f.engine.readOrder(buyer, 'checkout', 500)?.amountMinor, product.priceMinor);
  assert.equal(minorUnits('900719925474099300'), 900719925474099300n);
  for (const value of ['01', '-1', '1.2', '1e2', '9'.repeat(31)]) assert.throws(() => minorUnits(value));
});
test('signed provider settlement is scoped, immutable and exactly idempotent under concurrency', async () => {
  const { f } = await prepared(); const results = await Promise.all([f.engine.settle(raw, 'signed', 300), f.engine.settle(raw, 'signed', 300)]);
  assert.ok(results.every(x => x.status === 'settled' && x.settlementEventId === 'event'));
  assert.equal(f.engine.readOrder(buyer, 'checkout', 300)?.status, 'settled');
});
test('forgery, tenant/buyer/product/money/currency/payment substitution and stale quotes fail', async () => {
  const { f, event } = await prepared(); f.setVerified(false); await assert.rejects(f.engine.settle(raw, 'forged', 300)); f.setVerified(true);
  const mutations: Partial<SettlementEvent>[] = [{ scope: { ...scope, tenantId: 'other' } }, { buyerId: 'other' }, { productDigestHex: 'f'.repeat(64) }, { amountMinor: '1' }, { currency: { code: 'EUR', minorUnit: 2 } }, { providerPaymentId: 'other' }, { merchantAccountId: 'other' }, { occurredAtMs: 10_100 }, { occurredAtMs: 99 }];
  for (const mutation of mutations) { f.setEvent({ ...event, ...mutation }); await assert.rejects(f.engine.settle(raw, 'signed', 20_000)); }
  assert.equal(f.engine.readOrder(buyer, 'checkout', 300)?.status, 'pending');
  f.setEvent(event); await f.engine.settle(raw, 'signed', 300); f.setEvent({ ...event, amountMinor: '1' }); await assert.rejects(f.engine.settle(raw, 'signed', 300), /PAYMENT_EVENT_ID_CONFLICT/);
  f.setEvent({ ...event, eventId: 'different' }); await assert.rejects(f.engine.settle(raw, 'signed', 300), /CHECKOUT_ALREADY_SETTLED/);
});
test('provider failures leave retryable reservations and payment IDs cannot be reused', async () => {
  const f = commerceFixture(); f.setFailure(true); await assert.rejects(f.engine.createCheckout(buyer, request, 100)); assert.equal(f.engine.readOrder(buyer, 'checkout', 100)?.status, 'reserved');
  f.setFailure(false); await f.engine.createCheckout(buyer, request, 200);
  assert.equal(f.requests[0]!.idempotencyKeyHex, f.requests[1]!.idempotencyKeyHex);
  await assert.rejects(f.engine.createCheckout(buyer, { ...request, checkoutId: 'second' }, 300), /PAYMENT_ID_REUSE/);
  assert.equal(f.engine.readOrder(buyer, 'second', 300)?.status, 'reserved');
});
test('missing rights, revoked permission, unauthorized roles and buyer collisions reject', async () => {
  const f = commerceFixture(); await assert.rejects(f.engine.createCheckout({ ...buyer, application: 'scenesignal' }, request, 100));
  assert.throws(() => new CheckoutEngine(scope, new RightsCatalog({ ...scope, tenantId: 'other' }), f.provider, f.verifier, new MemoryCommerceStore()), /COMMERCE_RIGHTS_SCOPE_MISMATCH/);
  await assert.rejects(f.engine.createCheckout(buyer, { ...request, territory: 'GB' }, 100), /PRODUCT_RIGHTS_DENIED/);
  f.rights.revoke(manager, 'rights1', 100); await assert.rejects(f.engine.createCheckout(buyer, request, 100), /PRODUCT_RIGHTS_DENIED/);
  assert.throws(() => f.engine.registerProduct(buyer, product, 100));
  const ready = await prepared(); await assert.rejects(ready.f.engine.createCheckout({ ...buyer, identityId: 'other' }, request, 300), /CHECKOUT_ID_CONFLICT/);
  assert.throws(() => ready.f.engine.readOrder({ ...buyer, identityId: 'other' }, 'checkout', 300));
});
test('commerce transactions roll back errors and reject async callbacks', () => {
  const store = new MemoryCommerceStore(); assert.throws(() => store.transact(scope, state => { state.payments.set('payment', 'x'); throw Error('rollback'); }));
  assert.equal(store.transact(scope, state => state.payments.size), 0);
  assert.throws(() => store.transact(scope, () => Promise.resolve(1)), /ASYNC_COMMERCE_TRANSACTION/);
});
