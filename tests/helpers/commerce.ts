import assert from 'node:assert/strict';
import { CheckoutEngine, MemoryCommerceStore, RightsCatalog } from '../../src/index.js';
import type { AuthenticatedActor, CompleteProduct, PaymentEventVerifier, PaymentIntentRequest, PaymentProvider, SettlementEvent, IdentityScope, CommerceStore } from '../../src/index.js';
export const scope: IdentityScope = { tenantId: 'tenant', application: 'distributed-radio', identityId: 'merchant' };
export const manager: AuthenticatedActor = { ...scope, deviceId: 'device', expiresAtMs: 100_000, permissions: ['rights:write', 'commerce:manage'] };
export const buyer: AuthenticatedActor = { ...manager, identityId: 'buyer', permissions: ['commerce:buy'] };
export const product: CompleteProduct = { id: 'complete', revision: 1, assets: [{ assetId: 'one', rightsLayers: ['recording'] }, { assetId: 'two', rightsLayers: ['spoken-work'] }], currency: { code: 'USD', minorUnit: 2 }, priceMinor: '123456789012345678901234', validUntilMs: 100_000 };
export function commerceFixture(store: CommerceStore = new MemoryCommerceStore()) {
  const rights = new RightsCatalog(scope);
  for (const [i, asset] of product.assets.entries()) rights.add(manager, { id: `rights${i}`, assetId: asset.assetId, layer: asset.rightsLayers[0]!, uses: ['sale', 'download'], territories: ['US'], validFromMs: 0, validUntilMs: 100_000, authorizationEvidenceRef: 'sha256:' + 'a'.repeat(64), revoked: false }, 1);
  const requests: PaymentIntentRequest[] = []; let failure = false, responseId = 'payment'; let verified = true; let event: SettlementEvent;
  const provider: PaymentProvider = { providerId: 'provider', merchantAccountId: 'account', async createIntent(request) { requests.push(structuredClone(request)); if (failure) throw Error('provider unavailable'); return { providerId: 'provider', merchantAccountId: 'account', providerPaymentId: responseId, currency: request.currency, amountMinor: request.amountMinor }; } };
  const verifier: PaymentEventVerifier = { async verify() { assert.ok(verified, 'provider authentication failed'); return structuredClone(event); } };
  const engine = new CheckoutEngine(scope, rights, provider, verifier, store, 10_000);
  engine.registerProduct(manager, product, 1);
  return { engine, rights, requests, provider, verifier, setFailure(value: boolean) { failure = value; }, setResponseId(value: string) { responseId = value; }, setVerified(value: boolean) { verified = value; }, setEvent(value: SettlementEvent) { event = value; } };
}
