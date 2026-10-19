import type { Scope, OutputRoute } from './contracts.js';
import type { SignedControl, ControlVerifier } from './controls.js';
import type { ControlPayloadDecoder } from './safety.js';
import type { AcceptedAcousticEvidence, EvidenceChallenge } from './evidence.js';
import { OutputEvidenceEndpoint } from './evidence.js';
import { DeviceRouteProfiles, type RouteObservation } from './device-profiles.js';
import { canonicalJson, integer, invariant } from './validation.js';

/** Opt-in endpoint boundary: route reports alone never establish sound evidence. */
export class OptInAcousticAdapter {
  readonly routes: DeviceRouteProfiles;
  private readonly endpoint: OutputEvidenceEndpoint;
  private consentUntilMs = 0;
  constructor(scope: Scope, verifier: ControlVerifier, decode: ControlPayloadDecoder,
    private readonly nowMs: () => number) {
    this.endpoint = new OutputEvidenceEndpoint(scope, verifier, decode, nowMs);
    this.routes = new DeviceRouteProfiles(() => this.revoke());
  }
  /** Caller must supply actual, informed microphone-capture consent. */
  grantConsent(untilMs: number): void {
    const now = this.nowMs();
    integer(now, 0); integer(untilMs, now + 1);
    invariant(untilMs <= now + 86400000, 'CONSENT_DURATION_LIMIT');
    this.consentUntilMs = untilMs;
    this.endpoint.invalidate();
  }
  revoke(): void {
    this.consentUntilMs = 0;
    this.endpoint.invalidate();
  }
  observeNativeRoute(observation: RouteObservation): void { this.routes.observe(observation); }
  interrupt(): void { this.routes.interrupt(); }
  disconnect(): void { this.routes.disconnect(); }
  challenge(): EvidenceChallenge {
    const profile = this.routes.snapshot();
    const now = this.nowMs(); integer(now, 0);
    invariant(this.consentUntilMs > now, 'ACOUSTIC_CONSENT_REQUIRED');
    invariant(profile.state === 'active' && profile.playbackSupported && profile.route,
      'ACTIVE_OUTPUT_REQUIRED');
    this.routes.requireCurrent(profile.route, profile.generation);
    return this.endpoint.challenge(profile.route, this.consentUntilMs);
  }
  async accept(signedMeasurement: SignedControl, route: OutputRoute, generation: number): Promise<AcceptedAcousticEvidence> {
    const now = this.nowMs(); integer(now, 0);
    invariant(this.consentUntilMs > now, 'ACOUSTIC_CONSENT_REQUIRED');
    this.routes.requireCurrent(route, generation);
    const evidence = await this.endpoint.accept(signedMeasurement);
    invariant(this.consentUntilMs > this.nowMs(), 'ACOUSTIC_CONSENT_EXPIRED');
    this.routes.requireCurrent(route, generation);
    invariant(canonicalJson(evidence.route) === canonicalJson(route), 'ACOUSTIC_ROUTE_MISMATCH');
    return evidence;
  }
}
