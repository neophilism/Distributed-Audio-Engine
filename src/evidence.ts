import type { Scope, OutputRoute } from './contracts.js';
import type { SignedControl, ControlVerifier } from './controls.js';
import type { ControlPayloadDecoder } from './safety.js';
import { canonicalJson, finite, identifier, integer, invariant } from './validation.js';

export interface EvidenceChallenge { nonce: string; scope: Scope; route: OutputRoute; issuedAtMs: number; expiresAtMs: number }
/** Minimal calibrated decision evidence. Raw microphone captures remain at the consented endpoint. */
export interface AcousticEvidence {
  nonce: string; evidenceId: string; scope: Scope; route: OutputRoute;
  fromMs: number; toMs: number; measuredDbA: number; uncertaintyDb: number;
  clockUncertaintyMs: number; calibrationId: string; calibrationFromMs: number;
  calibrationUntilMs: number; consentUntilMs: number;
  geometryId: string; weighting: 'A'; measurementWindowMs: number;
  sourceAttribution: 'validated' | 'inconclusive'; origin: 'captured' | 'simulated';
  outputAttribution: 'independent' | 'aggregate';
}
const accepted = new WeakSet<object>();
const qualified = new WeakSet<object>();
declare const authenticatedEvidence: unique symbol;
export type AcceptedAcousticEvidence = Readonly<AcousticEvidence> & { readonly [authenticatedEvidence]: true };
function exact(value: object, keys: string): void { invariant(Object.keys(value).sort().join(',') === keys.split(',').sort().join(','), 'UNKNOWN_EVIDENCE_FIELDS'); }
function route(value: OutputRoute): void {
  exact(value, 'endpointId,routeId,outputId,kind,generation');
  identifier(value.endpointId); identifier(value.routeId); identifier(value.outputId); integer(value.generation, 1);
  invariant(['bluetooth-speaker','wired-speaker','headphones','internal','unknown'].includes(value.kind), 'INVALID_OUTPUT_KIND');
}
function validate(value: AcousticEvidence): void {
  exact(value, 'nonce,evidenceId,scope,route,fromMs,toMs,measuredDbA,uncertaintyDb,clockUncertaintyMs,calibrationId,calibrationFromMs,calibrationUntilMs,consentUntilMs,geometryId,weighting,measurementWindowMs,sourceAttribution,origin,outputAttribution');
  exact(value.scope, 'tenantId,application,sessionId'); route(value.route);
  identifier(value.evidenceId); identifier(value.calibrationId); identifier(value.geometryId);
  identifier(value.scope.tenantId); identifier(value.scope.sessionId);
  invariant(value.scope.application === 'scenesignal' || value.scope.application === 'distributed-radio', 'INVALID_APPLICATION');
  invariant(/^[0-9a-f]{64}$/.test(value.nonce), 'INVALID_EVIDENCE_NONCE');
  integer(value.fromMs); integer(value.toMs, value.fromMs + 1); integer(value.calibrationFromMs);
  integer(value.calibrationUntilMs, value.calibrationFromMs + 1); integer(value.consentUntilMs);
  finite(value.measuredDbA, 0, 160); finite(value.uncertaintyDb, 0, 40); finite(value.clockUncertaintyMs, 0, 5000);
  integer(value.measurementWindowMs, 1, 60000); invariant(value.toMs - value.fromMs === value.measurementWindowMs, 'EVIDENCE_WINDOW_MISMATCH');
  invariant(value.weighting === 'A' && ['validated','inconclusive'].includes(value.sourceAttribution) && ['captured','simulated'].includes(value.origin) && ['independent','aggregate'].includes(value.outputAttribution), 'INVALID_MEASUREMENT_METHOD');
}

/** Uses the existing pinned-signer control verifier and authenticated E2EE decoder. No key establishment here. */
export class OutputEvidenceEndpoint {
  private pending: EvidenceChallenge | undefined;
  private generation = 0;
  private readonly scope: Scope;
  constructor(scope: Scope, private readonly verifier: ControlVerifier, private readonly decode: ControlPayloadDecoder, private readonly nowMs: () => number) {
    invariant(verifier.matchesScope(scope), 'EVIDENCE_SCOPE_MISMATCH'); this.scope = structuredClone(scope);
  }
  challenge(activeRoute: OutputRoute, consentUntilMs: number): EvidenceChallenge {
    route(activeRoute); const now = this.nowMs(); integer(now); integer(consentUntilMs, now + 1);
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
    this.generation++; this.pending = { nonce, scope: this.scope, route: structuredClone(activeRoute), issuedAtMs: now, expiresAtMs: Math.min(consentUntilMs, now + 60000) };
    return structuredClone(this.pending);
  }
  /** Native route changes, revocation, mute, interruption and consent withdrawal call this immediately. */
  invalidate(): void { this.generation++; this.pending = undefined; }
  async accept(control: SignedControl): Promise<AcceptedAcousticEvidence> {
    const pending = this.pending; const generation = this.generation; const now = this.nowMs(); integer(now);
    invariant(pending && pending.expiresAtMs > now && control.body.action === 'output-evidence', 'NO_ACTIVE_EVIDENCE_CHALLENGE');
    const body = await this.verifier.accept(control, now);
    const decoded = await this.decode(body);
    invariant(generation === this.generation && this.pending?.nonce === pending.nonce, 'EVIDENCE_SUPERSEDED');
    // Consume before parsing. Invalid or overlapping replies cannot reuse this challenge.
    this.invalidate(); const finalNow = this.nowMs(); integer(finalNow, now);
    invariant(finalNow < pending.expiresAtMs, 'EVIDENCE_CHALLENGE_EXPIRED');
    invariant(decoded && typeof decoded === 'object', 'INVALID_EVIDENCE');
    const value = structuredClone(decoded) as AcousticEvidence; validate(value);
    invariant(value.nonce === pending.nonce && canonicalJson(value.scope) === canonicalJson(pending.scope) && canonicalJson(value.route) === canonicalJson(pending.route), 'EVIDENCE_BINDING_MISMATCH');
    invariant(value.fromMs - value.clockUncertaintyMs >= pending.issuedAtMs && value.toMs + value.clockUncertaintyMs <= now && value.toMs <= pending.expiresAtMs && value.consentUntilMs >= value.toMs + value.clockUncertaintyMs && value.consentUntilMs <= pending.expiresAtMs, 'EVIDENCE_TIME_OR_CONSENT_MISMATCH');
    // Freeze nested routing too; caller mutations must not turn headphone evidence into speaker evidence.
    Object.freeze(value.route); Object.freeze(value.scope); Object.freeze(value);
    accepted.add(value); return value as AcceptedAcousticEvidence;
  }
}

export interface ContributionBand {
  version: string; geometryId: string; measurementWindowMs: number;
  minimumDbA: number; safetyCeilingDbA: number; maximumUncertaintyDb: number;
  maximumClockUncertaintyMs: number; allowedKinds: readonly ('bluetooth-speaker' | 'wired-speaker')[];
}
export type QualifyingInterval = { qualified: false; reason: string } | {
  qualified: true; scope: Scope; evidenceId: string; outputId: string; fromMs: number; toMs: number;
  conservativeDbA: number; upperDbA: number; policyVersion: string;
  assurance: 'authenticated-verifier-decision'; fieldValidated: false;
};
/** No volume instruction, points, reward policy or audience estimate is produced by this neutral evaluator. */
export function evaluateContribution(evidence: AcceptedAcousticEvidence, policy: ContributionBand, bounds: { fromMs: number; toMs: number }): QualifyingInterval {
  invariant(accepted.has(evidence), 'UNAUTHENTICATED_EVIDENCE');
  identifier(policy.version); identifier(policy.geometryId); integer(policy.measurementWindowMs, 1, 60000);
  finite(policy.minimumDbA, 0, 160); finite(policy.safetyCeilingDbA, policy.minimumDbA, 160);
  finite(policy.maximumUncertaintyDb, 0, 40); finite(policy.maximumClockUncertaintyMs, 0, 5000);
  invariant(policy.allowedKinds.length > 0 && new Set(policy.allowedKinds).size === policy.allowedKinds.length && policy.allowedKinds.every(k => k === 'bluetooth-speaker' || k === 'wired-speaker'), 'INVALID_CONTRIBUTION_ROUTES');
  integer(bounds.fromMs); integer(bounds.toMs, bounds.fromMs + 1);
  const e = evidence;
  if (e.origin !== 'captured' || e.sourceAttribution !== 'validated' || e.outputAttribution !== 'independent') return { qualified: false, reason: 'INCONCLUSIVE_OUTPUT' };
  if (!policy.allowedKinds.some(k => k === e.route.kind)) return { qualified: false, reason: 'INELIGIBLE_ROUTE' };
  if (e.geometryId !== policy.geometryId || e.measurementWindowMs !== policy.measurementWindowMs || e.uncertaintyDb > policy.maximumUncertaintyDb || e.clockUncertaintyMs > policy.maximumClockUncertaintyMs) return { qualified: false, reason: 'UNSUPPORTED_MEASUREMENT' };
  if (e.calibrationFromMs > e.fromMs - e.clockUncertaintyMs || e.calibrationUntilMs < e.toMs + e.clockUncertaintyMs) return { qualified: false, reason: 'CALIBRATION_DOES_NOT_COVER_WINDOW' };
  const lower = e.measuredDbA - e.uncertaintyDb; const upper = e.measuredDbA + e.uncertaintyDb;
  if (lower < policy.minimumDbA || upper > policy.safetyCeilingDbA) return { qualified: false, reason: 'LEVEL_OUTSIDE_BAND' };
  const fromMs = Math.ceil(Math.max(bounds.fromMs, e.fromMs + e.clockUncertaintyMs, e.calibrationFromMs));
  const toMs = Math.floor(Math.min(bounds.toMs, e.toMs - e.clockUncertaintyMs, e.calibrationUntilMs, e.consentUntilMs));
  if (fromMs >= toMs) return { qualified: false, reason: 'NO_CERTAIN_INTERVAL' };
  const result: QualifyingInterval = Object.freeze({ qualified: true, scope: e.scope, evidenceId: e.evidenceId, outputId: e.route.outputId, fromMs, toMs, conservativeDbA: lower, upperDbA: upper, policyVersion: policy.version, assurance: 'authenticated-verifier-decision', fieldValidated: false });
  qualified.add(result); return result;
}

/** Deduplicate physical outputs and union overlapping authenticated intervals rather than declared output counts. */
export function contributionCoverage(intervals: readonly QualifyingInterval[]): { outputId: string; durationMs: number }[] {
  invariant(intervals.length <= 10000, 'TOO_MANY_INTERVALS');
  const groups = new Map<string, { fromMs: number; toMs: number }[]>();
  let context: string | undefined;
  for (const i of intervals) if (i.qualified) {
    invariant(qualified.has(i), 'UNAUTHENTICATED_QUALIFYING_INTERVAL');
    const key = canonicalJson({ scope: i.scope, policyVersion: i.policyVersion });
    invariant(context === undefined || context === key, 'MIXED_CONTRIBUTION_CONTEXT'); context = key;
    identifier(i.outputId); integer(i.fromMs); integer(i.toMs, i.fromMs + 1);
    const rows = groups.get(i.outputId) ?? []; rows.push(i); groups.set(i.outputId, rows);
  }
  return [...groups].map(([outputId, rows]) => {
    rows.sort((a, b) => a.fromMs - b.fromMs); let end = 0; let durationMs = 0;
    for (const r of rows) { durationMs += Math.max(0, r.toMs - Math.max(end, r.fromMs)); end = Math.max(end, r.toMs); }
    integer(durationMs); return { outputId, durationMs };
  }).sort((a, b) => a.outputId < b.outputId ? -1 : a.outputId > b.outputId ? 1 : 0);
}

