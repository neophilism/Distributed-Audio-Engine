import type { AcceptedAcousticEvidence, ContributionBand, QualifyingInterval } from './evidence.js';
import { evaluateContribution } from './evidence.js';
import type { RouteProfile } from './device-profiles.js';
import { canonicalJson, integer, invariant } from './validation.js';

export interface WindowBounds { fromMs: number; toMs: number }

/** Dynamic fail-closed qualification gate. Route observations do not prove acoustic emission. */
export function evaluateCurrentWindow(
  evidence: AcceptedAcousticEvidence, policy: ContributionBand, bounds: WindowBounds,
  profile: Readonly<RouteProfile>, nowMs: number,
): QualifyingInterval {
  integer(nowMs, 0);
  integer(bounds.fromMs, 0); integer(bounds.toMs, bounds.fromMs + 1);
  invariant(profile && typeof profile === 'object', 'CURRENT_ROUTE_PROFILE_REQUIRED');
  if (profile.state !== 'active' || !profile.playbackSupported || !profile.route)
    return { qualified: false, reason: 'OUTPUT_NOT_ACTIVE' };
  if (profile.generation !== evidence.route.generation ||
      canonicalJson(profile.route) !== canonicalJson(evidence.route))
    return { qualified: false, reason: 'ROUTE_CHANGED' };
  if (evidence.consentUntilMs <= nowMs)
    return { qualified: false, reason: 'CONSENT_EXPIRED' };
  if (evidence.toMs > nowMs || bounds.fromMs > nowMs)
    return { qualified: false, reason: 'FUTURE_WINDOW' };
  return evaluateContribution(evidence, policy, bounds);
}
