import type { AuthenticatedActor } from './identity.js';
import type { CheckoutEngine, CompleteProduct } from './commerce.js';
import { commerceDigest } from './commerce.js';
import type { EntitlementGrant, EntitlementLedger, EntitlementUse } from './entitlements.js';
import { identifier, invariant } from './validation.js';

export interface CompleteProductResolver {
  /** Resolve the immutable product revision that was quoted. Missing or changed revisions must not be substituted. */
  resolve(productId: string, revision: number): Promise<CompleteProduct | undefined>;
}

export interface SettledPurchaseEntitlementOptions {
  grantId: string;
  uses: EntitlementUse[];
  expiresAtMs: number | null;
  authorizationEvidenceRef: string;
}

/**
 * Bridges an authoritative settled checkout to generic asset entitlements.
 * The bridge never handles provider credentials, media keys, or recipient key delivery.
 */
export class SettledPurchaseEntitlementIssuer {
  constructor(
    private readonly checkout: CheckoutEngine,
    private readonly entitlements: EntitlementLedger,
    private readonly products: CompleteProductResolver,
  ) {}

  async issue(
    issuer: AuthenticatedActor,
    buyer: AuthenticatedActor,
    checkoutId: string,
    options: SettledPurchaseEntitlementOptions,
    nowMs: number,
  ): Promise<EntitlementGrant> {
    identifier(checkoutId);
    invariant(options && Object.keys(options).sort().join(',') === 'authorizationEvidenceRef,expiresAtMs,grantId,uses', 'UNKNOWN_SETTLED_ENTITLEMENT_FIELDS');
    const order = this.checkout.readOrder(buyer, checkoutId, nowMs);
    invariant(order, 'UNKNOWN_SETTLED_CHECKOUT');
    invariant(order.status === 'settled' && order.settlementEventId !== null && order.settledAtMs !== null, 'CHECKOUT_NOT_SETTLED');

    const product = structuredClone(await this.products.resolve(order.productId, order.productRevision));
    invariant(product && product.id === order.productId && product.revision === order.productRevision, 'SETTLED_PRODUCT_UNAVAILABLE');
    const digest = await commerceDigest({ domain: 'DAE-COMPLETE-PRODUCT-v1', scope: order.scope, product });
    invariant(digest === order.productDigestHex, 'SETTLED_PRODUCT_MISMATCH');

    return this.entitlements.grant(issuer, {
      grantId: options.grantId,
      subjectId: order.buyerId,
      resources: product.assets.map(asset => ({ resourceId: asset.assetId, uses: structuredClone(options.uses) })),
      source: { kind: 'purchase', recordId: order.checkoutId },
      expiresAtMs: options.expiresAtMs,
      authorizationEvidenceRef: options.authorizationEvidenceRef,
    }, nowMs);
  }
}
