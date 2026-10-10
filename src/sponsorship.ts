import type { AuthenticatedActor, IdentityScope } from './identity.js';
import { requireAccess } from './identity.js';
import { validateCommerceScope } from './commerce.js';
import { canonicalJson, identifier, integer, invariant } from './validation.js';

/** Generic campaign accounting; no ad targeting, billing, people counts, or radio cadence. */
export interface SponsorCampaign {
  campaignId: string;
  creativeIds: string[];
  startsAtMs: number;
  endsAtMs: number;
  maxDeliveries: number;
  approvalEvidenceRef: string;
}
export interface SponsorEventBase {
  scope: IdentityScope;
  eventId: string;
  campaignId: string;
  creativeId: string;
  occurredAtMs: number;
}
export type SponsorEvent = SponsorEventBase & (
  { kind: 'delivery'; deliveryEventId: null; outputEvidenceRef: null } |
  { kind: 'qualified-output'; deliveryEventId: string; outputEvidenceRef: string }
);
/** Verify the raw authenticated provider record before returning an immutable fact.
 * For qualified-output, independently verify calibrated native output evidence first.
 * This interface is NOT a hardware attestation or a cryptographic verifier.
 */
export interface SponsorEventVerifier {
  verify(raw: Uint8Array<ArrayBuffer>, authentication: string, nowMs: number): Promise<SponsorEvent>;
}
export interface SponsorState {
  campaigns: Map<string, SponsorCampaign>;
  events: Map<string, SponsorEvent>;
  qualifiedDeliveries: Map<string, string>;
}
export interface SponsorStore {
  /** Atomic sync transaction, rollback on throw, no asynchronous callback. */
  transact<T>(scope: IdentityScope, operation: (state: SponsorState) => T): T;
}
const keys = (value: object): string => Object.keys(value).sort().join(',');
const evidence = (value: string): void => { invariant(typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value), 'INVALID_SPONSOR_EVIDENCE'); };
function validateCampaign(value: SponsorCampaign): SponsorCampaign {
  invariant(value && keys(value) === 'approvalEvidenceRef,campaignId,creativeIds,endsAtMs,maxDeliveries,startsAtMs', 'UNKNOWN_SPONSOR_CAMPAIGN_FIELD');
  const copy = structuredClone(value);
  identifier(copy.campaignId);
  integer(copy.startsAtMs);
  integer(copy.endsAtMs, copy.startsAtMs + 1);
  integer(copy.maxDeliveries, 1, 100000);
  evidence(copy.approvalEvidenceRef);
  invariant(Array.isArray(copy.creativeIds) && copy.creativeIds.length > 0 && copy.creativeIds.length <= 128, 'INVALID_SPONSOR_CREATIVES');
  copy.creativeIds.forEach(identifier);
  invariant(new Set(copy.creativeIds).size === copy.creativeIds.length, 'DUPLICATE_SPONSOR_CREATIVE');
  copy.creativeIds.sort();
  return copy;
}
function validateEvent(value: SponsorEvent): SponsorEvent {
  invariant(value && keys(value) === 'campaignId,creativeId,deliveryEventId,eventId,kind,occurredAtMs,outputEvidenceRef,scope', 'UNKNOWN_SPONSOR_EVENT_FIELD');
  const copy = structuredClone(value);
  validateCommerceScope(copy.scope);
  identifier(copy.campaignId); identifier(copy.creativeId); identifier(copy.eventId); integer(copy.occurredAtMs);
  if (copy.kind === 'delivery') {
    invariant(copy.deliveryEventId === null && copy.outputEvidenceRef === null, 'INVALID_SPONSOR_DELIVERY');
  } else if (copy.kind === 'qualified-output') {
    identifier(copy.deliveryEventId); evidence(copy.outputEvidenceRef);
    invariant(copy.eventId !== copy.deliveryEventId, 'INVALID_SPONSOR_QUALIFICATION');
  } else throw Error('INVALID_SPONSOR_EVENT_KIND');
  return copy;
}
export function validateSponsorState(state: SponsorState, scope: IdentityScope): void {
  validateCommerceScope(scope);
  invariant(state.campaigns.size <= 2048 && state.events.size <= 10000 && state.qualifiedDeliveries.size <= 10000, 'SPONSOR_STORE_LIMIT');
  for (const [id, record] of state.campaigns)
    invariant(id === record.campaignId && canonicalJson(validateCampaign(record)) === canonicalJson(record), 'SPONSOR_CAMPAIGN_STATE');
  for (const [id, record] of state.events)
    invariant(id === record.eventId && canonicalJson(validateEvent(record)) === canonicalJson(record) &&
      canonicalJson(record.scope) === canonicalJson(scope), 'SPONSOR_EVENT_STATE');
  for (const [deliveryId, qualifiedId] of state.qualifiedDeliveries) {
    const delivery = state.events.get(deliveryId), qualified = state.events.get(qualifiedId);
    invariant(delivery?.kind === 'delivery' && qualified?.kind === 'qualified-output' &&
      qualified.deliveryEventId === deliveryId && delivery.campaignId === qualified.campaignId &&
      delivery.creativeId === qualified.creativeId, 'SPONSOR_QUALIFICATION_STATE');
  }
}
export class MemorySponsorStore implements SponsorStore {
  private readonly states = new Map<string, SponsorState>();
  private busy = false;
  transact<T>(scope: IdentityScope, operation: (state: SponsorState) => T): T {
    validateCommerceScope(scope);
    invariant(!this.busy, 'SPONSOR_REENTRANT_TRANSACTION'); this.busy = true;
    try {
      const key = canonicalJson(scope);
      const draft = structuredClone(this.states.get(key) ?? {
        campaigns: new Map<string, SponsorCampaign>(),
        events: new Map<string, SponsorEvent>(),
        qualifiedDeliveries: new Map<string, string>()
      });
      const result = operation(draft);
      invariant(!(result && typeof result === 'object' && 'then' in result), 'ASYNC_SPONSOR_TRANSACTION');
      validateSponsorState(draft, scope);
      const detached = structuredClone(result);
      this.states.set(key, structuredClone(draft));
      return detached;
    } finally { this.busy = false; }
  }
}
export interface SponsorReport {
  campaignId: string;
  deliveredEvents: number;
  qualifiedOutputEvents: number;
  /** Physical listeners, viewers and people are never inferred from devices or events. */
  peopleCount: null;
  lastEventAtMs: number | null;
}
export class SponsorAccounting {
  private readonly scope: IdentityScope;
  constructor(scope: IdentityScope, private readonly store: SponsorStore, private readonly verifier: SponsorEventVerifier) {
    validateCommerceScope(scope); this.scope = structuredClone(scope);
  }
  register(actor: AuthenticatedActor, campaign: SponsorCampaign, nowMs: number): SponsorCampaign {
    requireAccess(actor, this.scope, 'commerce:manage', nowMs); integer(nowMs);
    const record = validateCampaign(campaign);
    return this.store.transact(this.scope, state => {
      const existing = state.campaigns.get(record.campaignId);
      if (existing) {
        invariant(canonicalJson(existing) === canonicalJson(record), 'SPONSOR_CAMPAIGN_CONFLICT');
        return existing;
      }
      state.campaigns.set(record.campaignId, record); return record;
    });
  }
  async accept(raw: Uint8Array<ArrayBuffer>, authentication: string, nowMs: number): Promise<SponsorReport> {
    integer(nowMs);
    const record = validateEvent(await this.verifier.verify(raw, authentication, nowMs));
    invariant(canonicalJson(record.scope) === canonicalJson(this.scope), 'SPONSOR_SCOPE_MISMATCH');
    invariant(record.occurredAtMs <= nowMs, 'FUTURE_SPONSOR_EVENT');
    return this.store.transact(this.scope, state => {
      const existing = state.events.get(record.eventId);
      if (existing) {
        invariant(canonicalJson(existing) === canonicalJson(record), 'SPONSOR_EVENT_CONFLICT');
        return this.reportFor(state, record.campaignId);
      }
      const campaign = state.campaigns.get(record.campaignId);
      invariant(campaign && record.occurredAtMs >= campaign.startsAtMs && record.occurredAtMs < campaign.endsAtMs, 'SPONSOR_CAMPAIGN_INACTIVE');
      invariant(campaign.creativeIds.includes(record.creativeId), 'UNKNOWN_SPONSOR_CREATIVE');
      if (record.kind === 'delivery') {
        const used = [...state.events.values()].filter(event => event.kind === 'delivery' && event.campaignId === record.campaignId).length;
        invariant(used < campaign.maxDeliveries, 'SPONSOR_DELIVERY_LIMIT');
      } else {
        const source = state.events.get(record.deliveryEventId);
        invariant(source?.kind === 'delivery' && source.campaignId === record.campaignId &&
          source.creativeId === record.creativeId && source.occurredAtMs <= record.occurredAtMs, 'SPONSOR_UNBOUND_OUTPUT');
        invariant(!state.qualifiedDeliveries.has(record.deliveryEventId), 'SPONSOR_DUPLICATE_QUALIFICATION');
        state.qualifiedDeliveries.set(record.deliveryEventId, record.eventId);
      }
      state.events.set(record.eventId, record);
      return this.reportFor(state, record.campaignId);
    });
  }
  report(actor: AuthenticatedActor, campaignId: string, nowMs: number): SponsorReport {
    requireAccess(actor, this.scope, 'commerce:manage', nowMs); identifier(campaignId);
    return this.store.transact(this.scope, state => this.reportFor(state, campaignId));
  }
  private reportFor(state: SponsorState, campaignId: string): SponsorReport {
    invariant(state.campaigns.has(campaignId), 'UNKNOWN_SPONSOR_CAMPAIGN');
    const events = [...state.events.values()].filter(event => event.campaignId === campaignId);
    return {
      campaignId,
      deliveredEvents: events.filter(event => event.kind === 'delivery').length,
      qualifiedOutputEvents: events.filter(event => event.kind === 'qualified-output').length,
      peopleCount: null,
      lastEventAtMs: events.length ? Math.max(...events.map(event => event.occurredAtMs)) : null
    };
  }
}
