import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EntitlementLedger, MemoryEntitlementStore, SettledPurchaseEntitlementIssuer } from '../src/index.js';
import type { SettlementEvent } from '../src/index.js';
import { buyer, commerceFixture, manager, product, scope } from './helpers/commerce.js';

const request = { checkoutId: 'checkout', productId: 'complete', productRevision: 1, territory: 'US' };
const evidence = 'sha256:' + 'd'.repeat(64);

async function settledFixture() {
  const commerce = commerceFixture();
  const pending = await commerce.engine.createCheckout(buyer, request, 100);
  const event: SettlementEvent = {
    scope, eventId: 'event', providerId: 'provider', merchantAccountId: 'account',
    checkoutId: pending.checkoutId, buyerId: buyer.identityId, productDigestHex: pending.productDigestHex,
    providerPaymentId: 'payment', currency: pending.currency, amountMinor: pending.amountMinor,
    occurredAtMs: 200, status: 'settled',
  };
  commerce.setEvent(event);
  await commerce.engine.settle(new Uint8Array([1]), 'signed', 300);
  const ledger = new EntitlementLedger(scope, new MemoryEntitlementStore());
  const issuer = new SettledPurchaseEntitlementIssuer(commerce.engine, ledger, {
    async resolve(id, revision) { return id === product.id && revision === product.revision ? product : undefined; },
  });
  return { commerce, ledger, issuer };
}

test('settled complete-product checkout grants only declared generic asset uses', async () => {
  const { ledger, issuer } = await settledFixture();
  const grant = await issuer.issue(
    { ...manager, permissions: ['entitlements:manage'] },
    buyer,
    'checkout',
    { grantId: 'purchase-grant', uses: ['stream', 'download'], expiresAtMs: 10_000, authorizationEvidenceRef: evidence },
    400,
  );
  assert.deepEqual(grant.resources.map(resource => resource.resourceId), ['one', 'two']);
  const reader = { ...buyer, permissions: ['assets:read'] as const };
  assert.equal(ledger.access(reader, 'one', 'stream', 500).allowed, true);
  assert.equal(ledger.access(reader, 'two', 'download', 500).allowed, true);
  assert.equal(ledger.access(reader, 'one', 'derive-spatial', 500).allowed, false);
});

test('pending checkout, product substitution and unauthorized issuance fail closed', async () => {
  const pending = commerceFixture();
  await pending.engine.createCheckout(buyer, request, 100);
  const ledger = new EntitlementLedger(scope, new MemoryEntitlementStore());
  const pendingIssuer = new SettledPurchaseEntitlementIssuer(pending.engine, ledger, { async resolve() { return product; } });
  const options = { grantId: 'grant', uses: ['download' as const], expiresAtMs: 10_000, authorizationEvidenceRef: evidence };
  await assert.rejects(pendingIssuer.issue({ ...manager, permissions: ['entitlements:manage'] }, buyer, 'checkout', options, 200), /CHECKOUT_NOT_SETTLED/);

  const settled = await settledFixture();
  const changed = { ...product, priceMinor: '1' };
  const substituted = new SettledPurchaseEntitlementIssuer(settled.commerce.engine, ledger, { async resolve() { return changed; } });
  await assert.rejects(substituted.issue({ ...manager, permissions: ['entitlements:manage'] }, buyer, 'checkout', options, 400), /SETTLED_PRODUCT_MISMATCH/);
  await assert.rejects(settled.issuer.issue(buyer, buyer, 'checkout', options, 400), /ACCESS_DENIED/);
});

test('settled checkout source is idempotent and cannot grant a conflicting second identity', async () => {
  const { ledger, issuer } = await settledFixture();
  const actor = { ...manager, permissions: ['entitlements:manage'] as const };
  const options = { grantId: 'first', uses: ['download' as const], expiresAtMs: 10_000, authorizationEvidenceRef: evidence };
  const first = await issuer.issue(actor, buyer, 'checkout', options, 400);
  const replay = await issuer.issue(actor, buyer, 'checkout', { ...options, grantId: 'second' }, 500);
  assert.equal(replay.grantId, first.grantId);
  await assert.rejects(issuer.issue(actor, buyer, 'checkout', { ...options, grantId: 'other', uses: ['stream'] }, 500), /ENTITLEMENT_ID_CONFLICT/);
  assert.equal(ledger.access({ ...buyer, permissions: ['assets:read'] }, 'one', 'download', 600).allowed, true);
});
