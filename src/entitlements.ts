import type { IdentityScope, AuthenticatedActor } from './identity.js';
import { requireAccess } from './identity.js';
import { validateCommerceScope } from './commerce.js';
import { canonicalJson, identifier, integer, invariant } from './validation.js';
export type EntitlementUse = 'stream' | 'download' | 'cache' | 'derive-spatial';
export interface EntitlementResource { resourceId: string; uses: EntitlementUse[] }
export interface EntitlementSource { kind: 'purchase' | 'contribution' | 'promotion' | 'manual'; recordId: string }
export interface EntitlementRequest {
  grantId: string; subjectId: string; resources: EntitlementResource[]; source: EntitlementSource;
  expiresAtMs: number | null; authorizationEvidenceRef: string;
}
export interface EntitlementGrant extends EntitlementRequest {
  scope: IdentityScope; issuedAtMs: number; revision: number; revokedAtMs: number | null; revocationId: string | null;
}
export interface EntitlementState { grants: Map<string, EntitlementGrant>; sources: Map<string, string> }
export interface EntitlementStore { transact<T>(scope: IdentityScope, operation: (state: EntitlementState) => T): T }
export function entitlementSourceKey(source: EntitlementSource): string {
  invariant(source && Object.keys(source).sort().join(',') === 'kind,recordId' && ['purchase', 'contribution', 'promotion', 'manual'].includes(source.kind), 'INVALID_ENTITLEMENT_SOURCE'); identifier(source.recordId);
  return `${source.kind}:${source.recordId}`;
}
export function normalizeEntitlementRequest(input: EntitlementRequest): EntitlementRequest {
  const value = structuredClone(input);
  invariant(Object.keys(value).sort().join(',') === 'authorizationEvidenceRef,expiresAtMs,grantId,resources,source,subjectId', 'UNKNOWN_ENTITLEMENT_FIELDS');
  identifier(value.grantId); identifier(value.subjectId); entitlementSourceKey(value.source);
  invariant(/^sha256:[0-9a-f]{64}$/.test(value.authorizationEvidenceRef), 'MISSING_ENTITLEMENT_AUTHORIZATION');
  if (value.expiresAtMs !== null) integer(value.expiresAtMs, 1);
  invariant(value.resources.length > 0 && value.resources.length <= 512 && new Set(value.resources.map(x => x.resourceId)).size === value.resources.length, 'INVALID_ENTITLEMENT_RESOURCES');
  for (const resource of value.resources) {
    invariant(Object.keys(resource).sort().join(',') === 'resourceId,uses', 'UNKNOWN_ENTITLEMENT_RESOURCE'); identifier(resource.resourceId);
    invariant(resource.uses.length > 0 && resource.uses.length <= 4 && new Set(resource.uses).size === resource.uses.length && resource.uses.every(x => ['stream', 'download', 'cache', 'derive-spatial'].includes(x)), 'INVALID_ENTITLEMENT_USES');
    resource.uses.sort();
  }
  value.resources.sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0); return value;
}
export function validateEntitlementState(state: EntitlementState, scope: IdentityScope): void {
  validateCommerceScope(scope); invariant(state.grants.size <= 8192 && state.sources.size <= 8192, 'ENTITLEMENT_STORE_LIMIT');
  for (const [id, grant] of state.grants) {
    invariant(Object.keys(grant).sort().join(',') === 'authorizationEvidenceRef,expiresAtMs,grantId,issuedAtMs,resources,revocationId,revokedAtMs,revision,scope,source,subjectId'.split(',').sort().join(','), 'UNKNOWN_ENTITLEMENT_GRANT');
    const { scope: bound, issuedAtMs, revision, revokedAtMs, revocationId, ...request } = grant;
    invariant(id === grant.grantId && canonicalJson(bound) === canonicalJson(scope) && canonicalJson(normalizeEntitlementRequest(request)) === canonicalJson(request), 'ENTITLEMENT_STATE_MISMATCH');
    integer(issuedAtMs); integer(revision, 1, 2); if (grant.expiresAtMs !== null) integer(grant.expiresAtMs, issuedAtMs + 1);
    if (revokedAtMs === null) invariant(revision === 1 && revocationId === null, 'INVALID_ENTITLEMENT_REVOCATION');
    else { integer(revokedAtMs, issuedAtMs); identifier(revocationId); invariant(revision === 2, 'INVALID_ENTITLEMENT_REVOCATION'); }
    invariant(state.sources.get(entitlementSourceKey(grant.source)) === id, 'ENTITLEMENT_SOURCE_MISMATCH');
  }
  for (const [key, id] of state.sources) invariant(state.grants.has(id) && entitlementSourceKey(state.grants.get(id)!.source) === key, 'ORPHAN_ENTITLEMENT_SOURCE');
}
export class MemoryEntitlementStore implements EntitlementStore {
  private readonly values = new Map<string, EntitlementState>(); private busy = false;
  transact<T>(scope: IdentityScope, operation: (state: EntitlementState) => T): T {
    scope = structuredClone(scope); validateCommerceScope(scope); invariant(!this.busy, 'ENTITLEMENT_REENTRANT_TRANSACTION'); this.busy = true;
    try {
      const key = canonicalJson(scope), draft = structuredClone(this.values.get(key) ?? { grants: new Map(), sources: new Map() });
      const result = operation(draft); invariant(!(result && typeof result === 'object' && 'then' in result), 'ASYNC_ENTITLEMENT_TRANSACTION'); validateEntitlementState(draft, scope);
      const snapshot = structuredClone(result); this.values.set(key, structuredClone(draft)); return snapshot;
    } finally { this.busy = false; }
  }
}
function binding(request: EntitlementRequest): string { const { grantId: _id, ...value } = request; return canonicalJson(value); }
/** Generic issuer-authorized access facts; no balances, point economics or cryptographic enrollment. */
export class EntitlementLedger {
  private readonly scope: IdentityScope;
  constructor(scope: IdentityScope, private readonly store: EntitlementStore) { validateCommerceScope(scope); this.scope = structuredClone(scope); }
  grant(actor: AuthenticatedActor, input: EntitlementRequest, nowMs: number): EntitlementGrant {
    requireAccess(actor, this.scope, 'entitlements:manage', nowMs); const request = normalizeEntitlementRequest(input);
    return this.store.transact(this.scope, state => {
      const sourceKey = entitlementSourceKey(request.source), sameId = state.grants.get(request.grantId), sourceId = state.sources.get(sourceKey);
      const existing = sameId ?? (sourceId ? state.grants.get(sourceId) : undefined);
      if (existing) {
        const { scope: _scope, issuedAtMs: _at, revision: _revision, revokedAtMs: _revoked, revocationId: _reason, ...original } = existing;
        invariant(binding(original) === binding(request) && (!sourceId || sourceId === existing.grantId), 'ENTITLEMENT_ID_CONFLICT'); return existing;
      }
      invariant(request.expiresAtMs === null || request.expiresAtMs > nowMs, 'ENTITLEMENT_ALREADY_EXPIRED');
      const grant: EntitlementGrant = { ...request, scope: structuredClone(this.scope), issuedAtMs: nowMs, revision: 1, revokedAtMs: null, revocationId: null };
      state.grants.set(grant.grantId, grant); state.sources.set(sourceKey, grant.grantId); return grant;
    });
  }
  revoke(actor: AuthenticatedActor, grantId: string, revocationId: string, nowMs: number): EntitlementGrant {
    requireAccess(actor, this.scope, 'entitlements:manage', nowMs); identifier(grantId); identifier(revocationId);
    return this.store.transact(this.scope, state => {
      const grant = state.grants.get(grantId); invariant(grant, 'UNKNOWN_ENTITLEMENT'); integer(nowMs, grant.issuedAtMs);
      if (grant.revokedAtMs === null) { grant.revokedAtMs = nowMs; grant.revocationId = revocationId; grant.revision = 2; }
      return grant;
    });
  }
  access(actor: AuthenticatedActor, resourceId: string, use: EntitlementUse, nowMs: number): { allowed: boolean; grantIds: string[] } {
    requireAccess(actor, { tenantId: this.scope.tenantId, application: this.scope.application, identityId: actor.identityId }, 'assets:read', nowMs); identifier(resourceId);
    invariant(['stream', 'download', 'cache', 'derive-spatial'].includes(use), 'INVALID_ENTITLEMENT_USE');
    return this.store.transact(this.scope, state => {
      const ids = [...state.grants.values()].filter(x => x.subjectId === actor.identityId && x.revokedAtMs === null && x.issuedAtMs <= nowMs && (x.expiresAtMs === null || x.expiresAtMs > nowMs) && x.resources.some(r => r.resourceId === resourceId && r.uses.includes(use))).map(x => x.grantId).sort();
      return { allowed: ids.length > 0, grantIds: ids };
    });
  }
}
