import type { AuthenticatedActor, IdentityScope } from './identity.js';
import { requireAccess } from './identity.js';
import type { RightsCatalog, RightsLayer } from './rights.js';
import { canonicalJson, identifier, integer, invariant } from './validation.js';

export interface Currency { code: string; minorUnit: number }
/** Exact nonnegative minor units; never a floating-point price. */
export function minorUnits(value: string): bigint {
  invariant(typeof value === 'string' && /^(?:0|[1-9][0-9]{0,29})$/.test(value), 'INVALID_MINOR_UNITS'); return BigInt(value);
}
export function validateCurrency(currency: Currency): void {
  invariant(currency && Object.keys(currency).sort().join(',') === 'code,minorUnit' && /^[A-Z]{3}$/.test(currency.code), 'INVALID_CURRENCY'); integer(currency.minorUnit, 0, 6);
}
export function validateCommerceScope(scope: IdentityScope): void {
  invariant(scope && Object.keys(scope).sort().join(',') === 'application,identityId,tenantId', 'INVALID_COMMERCE_SCOPE');
  identifier(scope.tenantId); identifier(scope.identityId); invariant(scope.application === 'scenesignal' || scope.application === 'distributed-radio', 'INVALID_APPLICATION');
}
const hex = (bytes: Uint8Array): string => Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
export async function commerceDigest(value: unknown): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)))));
}
export interface ProductAsset { assetId: string; rightsLayers: RightsLayer[] }
export interface CompleteProduct {
  id: string; revision: number; assets: ProductAsset[]; currency: Currency; priceMinor: string; validUntilMs: number;
}
export interface CheckoutRequest { checkoutId: string; productId: string; productRevision: number; territory: string }
export interface CheckoutOrder {
  scope: IdentityScope; checkoutId: string; buyerId: string; productId: string; productRevision: number; productDigestHex: string;
  territory: string; currency: Currency; amountMinor: string; createdAtMs: number; expiresAtMs: number;
  providerId: string; merchantAccountId: string; providerPaymentId: string | null; status: 'reserved' | 'pending' | 'settled';
  settlementEventId: string | null; settledAtMs: number | null;
}
export interface PaymentIntentRequest {
  scope: IdentityScope; checkoutId: string; buyerId: string; productDigestHex: string; currency: Currency;
  amountMinor: string; expiresAtMs: number; merchantAccountId: string; idempotencyKeyHex: string;
}
export interface PaymentIntent {
  providerId: string; merchantAccountId: string; providerPaymentId: string; currency: Currency; amountMinor: string;
}
/** Real adapters must enforce the supplied idempotency key at the provider. */
export interface PaymentProvider {
  readonly providerId: string; readonly merchantAccountId: string;
  createIntent(request: PaymentIntentRequest): Promise<PaymentIntent>;
}
export interface SettlementEvent {
  scope: IdentityScope; eventId: string; providerId: string; merchantAccountId: string; checkoutId: string;
  buyerId: string; productDigestHex: string; providerPaymentId: string; currency: Currency; amountMinor: string;
  occurredAtMs: number; status: 'settled';
}
/** Verify the provider's actual signed raw webhook using its documented scheme before returning. */
export interface PaymentEventVerifier { verify(raw: Uint8Array<ArrayBuffer>, authentication: string, nowMs: number): Promise<SettlementEvent> }
export interface CommerceEventRecord { digestHex: string; checkoutId: string }
export interface CommerceState {
  orders: Map<string, CheckoutOrder>; events: Map<string, CommerceEventRecord>; payments: Map<string, string>;
}
/** Synchronous, rollback-on-throw, cross-process atomic transaction. No network/await inside callback. */
export interface CommerceStore { transact<T>(scope: IdentityScope, operation: (state: CommerceState) => T): T }
export class MemoryCommerceStore implements CommerceStore {
  private readonly states = new Map<string, CommerceState>(); private busy = false;
  transact<T>(scope: IdentityScope, operation: (state: CommerceState) => T): T {
    validateCommerceScope(scope); invariant(!this.busy, 'COMMERCE_REENTRANT_TRANSACTION'); this.busy = true;
    try {
      const key = canonicalJson(scope), current = this.states.get(key) ?? { orders: new Map(), events: new Map(), payments: new Map() };
      const draft = structuredClone(current), result = operation(draft);
      invariant(!(result && typeof result === 'object' && 'then' in result), 'ASYNC_COMMERCE_TRANSACTION');
      invariant(draft.orders.size <= 4096 && draft.events.size <= 16384 && draft.payments.size <= 4096, 'COMMERCE_STORE_LIMIT');
      const snapshotResult = structuredClone(result); this.states.set(key, structuredClone(draft)); return snapshotResult;
    } finally { this.busy = false; }
  }
}
/** Merchant is an explicitly authorized recipient of opaque purchase/payment facts, never media keys. */
export class CheckoutEngine {
  private readonly scope: IdentityScope; private readonly products = new Map<string, CompleteProduct>();
  private readonly providerId: string; private readonly merchantAccountId: string;
  constructor(scope: IdentityScope, private readonly rights: RightsCatalog, private readonly provider: PaymentProvider, private readonly verifier: PaymentEventVerifier, private readonly store: CommerceStore, private readonly quoteLifetimeMs = 900_000, private readonly webhookMaxAgeMs = 86_400_000) {
    validateCommerceScope(scope); this.scope = structuredClone(scope); integer(quoteLifetimeMs, 1000, 900_000); integer(webhookMaxAgeMs, 1000, 604_800_000);
    invariant(rights.matchesScope(scope), 'COMMERCE_RIGHTS_SCOPE_MISMATCH');
    identifier(provider.providerId); identifier(provider.merchantAccountId); this.providerId = provider.providerId; this.merchantAccountId = provider.merchantAccountId;
  }
  registerProduct(actor: AuthenticatedActor, product: CompleteProduct, nowMs: number): void {
    requireAccess(actor, this.scope, 'commerce:manage', nowMs); const p = structuredClone(product);
    invariant(Object.keys(p).sort().join(',') === 'assets,currency,id,priceMinor,revision,validUntilMs', 'UNKNOWN_PRODUCT_FIELDS');
    identifier(p.id); integer(p.revision, 1); integer(p.validUntilMs, nowMs + 1); validateCurrency(p.currency); invariant(minorUnits(p.priceMinor) > 0n, 'ZERO_PRODUCT_PRICE');
    invariant(p.assets.length > 0 && p.assets.length <= 512 && new Set(p.assets.map(x => x.assetId)).size === p.assets.length, 'INVALID_COMPLETE_PRODUCT');
    for (const asset of p.assets) {
      invariant(Object.keys(asset).sort().join(',') === 'assetId,rightsLayers', 'UNKNOWN_PRODUCT_ASSET_FIELDS'); identifier(asset.assetId);
      // Evaluation validates layer names and rejects missing authorizations at checkout.
      invariant(asset.rightsLayers.length > 0 && asset.rightsLayers.length <= 4 && new Set(asset.rightsLayers).size === asset.rightsLayers.length && asset.rightsLayers.every(x => ['recording', 'composition', 'spoken-work', 'artwork'].includes(x)), 'INVALID_PRODUCT_RIGHTS');
    }
    const previous = this.products.get(p.id); invariant(!previous || p.revision > previous.revision, 'PRODUCT_REVISION_ROLLBACK'); this.products.set(p.id, p);
  }
  private buyer(actor: AuthenticatedActor, nowMs: number): void {
    requireAccess(actor, { tenantId: this.scope.tenantId, application: this.scope.application, identityId: actor.identityId }, 'commerce:buy', nowMs); identifier(actor.identityId);
  }
  readOrder(actor: AuthenticatedActor, checkoutId: string, nowMs: number): CheckoutOrder | undefined {
    this.buyer(actor, nowMs); identifier(checkoutId);
    return this.store.transact(this.scope, state => { const order = state.orders.get(checkoutId); invariant(!order || order.buyerId === actor.identityId, 'CHECKOUT_BUYER_MISMATCH'); return order; });
  }
  async createCheckout(actor: AuthenticatedActor, request: CheckoutRequest, nowMs: number): Promise<CheckoutOrder> {
    actor = structuredClone(actor); this.buyer(actor, nowMs); const r = structuredClone(request);
    invariant(Object.keys(r).sort().join(',') === 'checkoutId,productId,productRevision,territory', 'UNKNOWN_CHECKOUT_FIELDS');
    identifier(r.checkoutId); identifier(r.productId); integer(r.productRevision, 1); invariant(/^[A-Z]{2}$/.test(r.territory), 'INVALID_TERRITORY');
    const previous = this.store.transact(this.scope, state => state.orders.get(r.checkoutId));
    if (previous) {
      invariant(previous.buyerId === actor.identityId && previous.productId === r.productId && previous.productRevision === r.productRevision && previous.territory === r.territory, 'CHECKOUT_ID_CONFLICT');
      if (previous.status !== 'reserved') return previous;
    }
    const product = this.products.get(r.productId); invariant(product && product.revision === r.productRevision && product.validUntilMs > nowMs, 'PRODUCT_UNAVAILABLE');
    for (const asset of product.assets) invariant(this.rights.evaluate({ assetId: asset.assetId, layers: asset.rightsLayers, uses: ['sale', 'download'], territory: r.territory, atMs: nowMs }).allowed, 'PRODUCT_RIGHTS_DENIED');
    const digest = await commerceDigest({ domain: 'DAE-COMPLETE-PRODUCT-v1', scope: this.scope, product });
    const order = this.store.transact(this.scope, state => {
      const existing = state.orders.get(r.checkoutId);
      if (existing) {
        invariant(existing.buyerId === actor.identityId && existing.productDigestHex === digest && existing.territory === r.territory, 'CHECKOUT_ID_CONFLICT');
        invariant(existing.status === 'settled' || existing.expiresAtMs > nowMs, 'CHECKOUT_EXPIRED'); return existing;
      }
      const fresh: CheckoutOrder = { scope: structuredClone(this.scope), ...r, buyerId: actor.identityId, productDigestHex: digest, currency: structuredClone(product.currency), amountMinor: product.priceMinor,
        createdAtMs: nowMs, expiresAtMs: Math.min(nowMs + this.quoteLifetimeMs, product.validUntilMs), providerId: this.providerId, merchantAccountId: this.merchantAccountId,
        providerPaymentId: null, status: 'reserved', settlementEventId: null, settledAtMs: null };
      state.orders.set(fresh.checkoutId, fresh); return fresh;
    });
    if (order.status !== 'reserved') return order;
    const intentRequest: PaymentIntentRequest = { scope: structuredClone(this.scope), checkoutId: order.checkoutId, buyerId: order.buyerId, productDigestHex: order.productDigestHex, currency: structuredClone(order.currency), amountMinor: order.amountMinor,
      expiresAtMs: order.expiresAtMs, merchantAccountId: this.merchantAccountId, idempotencyKeyHex: await commerceDigest({ domain: 'DAE-PAYMENT-INTENT-v1', scope: this.scope, checkoutId: order.checkoutId }) };
    const response = structuredClone(await this.provider.createIntent(intentRequest));
    invariant(Object.keys(response).sort().join(',') === 'amountMinor,currency,merchantAccountId,providerId,providerPaymentId', 'UNKNOWN_PAYMENT_INTENT_FIELDS');
    identifier(response.providerPaymentId); validateCurrency(response.currency); minorUnits(response.amountMinor);
    invariant(response.providerId === this.providerId && response.merchantAccountId === this.merchantAccountId && response.amountMinor === order.amountMinor && canonicalJson(response.currency) === canonicalJson(order.currency), 'PAYMENT_INTENT_MISMATCH');
    return this.store.transact(this.scope, state => {
      const current = state.orders.get(order.checkoutId); invariant(current, 'UNKNOWN_CHECKOUT');
      invariant(current.providerPaymentId === null || current.providerPaymentId === response.providerPaymentId, 'PAYMENT_INTENT_CONFLICT');
      const owner = state.payments.get(response.providerPaymentId); invariant(!owner || owner === current.checkoutId, 'PAYMENT_ID_REUSE');
      current.providerPaymentId = response.providerPaymentId; if (current.status === 'reserved') current.status = 'pending'; state.payments.set(response.providerPaymentId, current.checkoutId); return current;
    });
  }
  async settle(raw: Uint8Array<ArrayBuffer>, authentication: string, nowMs: number): Promise<CheckoutOrder> {
    integer(nowMs); invariant(raw instanceof Uint8Array && raw.byteLength > 0 && raw.byteLength <= 65536 && typeof authentication === 'string' && authentication.length > 0 && authentication.length <= 4096, 'INVALID_PAYMENT_WEBHOOK');
    const event = structuredClone(await this.verifier.verify(raw.slice(), authentication, nowMs));
    invariant(Object.keys(event).sort().join(',') === 'amountMinor,buyerId,checkoutId,currency,eventId,merchantAccountId,occurredAtMs,productDigestHex,providerId,providerPaymentId,scope,status', 'UNKNOWN_SETTLEMENT_FIELDS');
    validateCommerceScope(event.scope); validateCurrency(event.currency); minorUnits(event.amountMinor); integer(event.occurredAtMs);
    for (const id of [event.eventId, event.buyerId, event.checkoutId, event.providerPaymentId]) identifier(id);
    invariant(event.status === 'settled' && canonicalJson(event.scope) === canonicalJson(this.scope) && event.providerId === this.providerId && event.merchantAccountId === this.merchantAccountId, 'SETTLEMENT_SCOPE_MISMATCH');
    invariant(event.occurredAtMs <= nowMs && nowMs - event.occurredAtMs <= this.webhookMaxAgeMs, 'SETTLEMENT_STALE_OR_FUTURE');
    const digestHex = await commerceDigest({ domain: 'DAE-SETTLEMENT-v1', event });
    return this.store.transact(this.scope, state => {
      const seen = state.events.get(event.eventId); invariant(!seen || seen.digestHex === digestHex, 'PAYMENT_EVENT_ID_CONFLICT');
      const order = state.orders.get(event.checkoutId); invariant(order && order.providerPaymentId === event.providerPaymentId, 'UNKNOWN_PAYMENT_INTENT');
      invariant(order.buyerId === event.buyerId && order.productDigestHex === event.productDigestHex && order.amountMinor === event.amountMinor && canonicalJson(order.currency) === canonicalJson(event.currency), 'SETTLEMENT_BINDING_MISMATCH');
      invariant(event.occurredAtMs >= order.createdAtMs && event.occurredAtMs < order.expiresAtMs, 'SETTLEMENT_OUTSIDE_QUOTE');
      if (seen) return order;
      invariant(order.status === 'pending', 'CHECKOUT_ALREADY_SETTLED');
      order.status = 'settled'; order.settlementEventId = event.eventId; order.settledAtMs = event.occurredAtMs;
      state.events.set(event.eventId, { digestHex, checkoutId: order.checkoutId }); return order;
    });
  }
}
