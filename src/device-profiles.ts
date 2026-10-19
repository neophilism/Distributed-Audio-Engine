import type { OutputRoute } from './contracts.js';
import { OutputLifecycle } from './output-lifecycle.js';
import { canonicalJson, integer, invariant } from './validation.js';
export type RouteOrigin = 'native-active-output' | 'paired-device' | 'display-name';
export interface RouteObservation {
  origin: RouteOrigin;
  route: OutputRoute;
  observedAtMs: number;
  playbackSupported: boolean;
  capabilities: readonly ('pcm-output' | 'low-latency' | 'multichannel')[];
}
export interface RouteProfile {
  state: 'active' | 'unavailable' | 'interrupted';
  generation: number;
  route?: Readonly<OutputRoute>;
  observedAtMs?: number;
  playbackSupported: boolean;
  capabilities: readonly string[];
  speakerProven: false;
  acousticQualification: 'unknown';
}
/** Only native-active output notifications can establish a route; neither a name nor pairing is proof. */
export class DeviceRouteProfiles {
  private readonly lifecycle: OutputLifecycle;
  private profile: RouteProfile = { state: 'unavailable', generation: 0, playbackSupported: false, capabilities: [], speakerProven: false, acousticQualification: 'unknown' };
  constructor(invalidateEvidence: () => void) { this.lifecycle = new OutputLifecycle(invalidateEvidence); }
  snapshot(): RouteProfile { return structuredClone(this.profile); }
  observe(observation: RouteObservation): RouteProfile {
    invariant(observation !== null && typeof observation === 'object' &&
      Object.keys(observation).sort().join(',') === 'capabilities,observedAtMs,origin,playbackSupported,route', 'INVALID_ROUTE_OBSERVATION');
    invariant(observation.origin === 'native-active-output', 'ACTIVE_NATIVE_ROUTE_REQUIRED');
    integer(observation.observedAtMs, 0);
    invariant(typeof observation.playbackSupported === 'boolean', 'INVALID_PLAYBACK_SUPPORT');
    invariant(Array.isArray(observation.capabilities) && observation.capabilities.length <= 3 &&
      new Set(observation.capabilities).size === observation.capabilities.length &&
      observation.capabilities.every(c => ['pcm-output','low-latency','multichannel'].includes(c)), 'INVALID_ROUTE_CAPABILITIES');
    invariant(observation.playbackSupported || observation.capabilities.length === 0, 'UNSUPPORTED_ROUTE_CAPABILITIES');
    try {
      this.lifecycle.active(observation.route, observation.playbackSupported);
      const state = this.lifecycle.snapshot();
      invariant(state.state === 'active', 'ROUTE_NOT_ACTIVE');
      this.profile = { state: 'active', generation: state.generation, route: state.route,
        observedAtMs: observation.observedAtMs, playbackSupported: state.playbackSupported,
        capabilities: [...observation.capabilities], speakerProven: false, acousticQualification: 'unknown' };
      return this.snapshot();
    } catch (error) {
      // The lifecycle invalidates before invoking the callback. If that callback
      // fails, never leave the previous active profile visible to consumers.
      const state = this.lifecycle.snapshot();
      if (state.state !== 'active') this.clear(state.state);
      throw error;
    }
  }
  interrupt(): void {
    try { this.lifecycle.interrupt(); }
    finally {
      const state = this.lifecycle.snapshot();
      if (state.state !== 'active') this.clear(state.state);
    }
  }
  disconnect(): void {
    try { this.lifecycle.disconnect(); }
    finally {
      const state = this.lifecycle.snapshot();
      if (state.state !== 'active') this.clear(state.state);
    }
  }
  private clear(state: 'interrupted' | 'unavailable'): void {
    this.profile = { state, generation: this.lifecycle.snapshot().generation, playbackSupported: false,
      capabilities: [], speakerProven: false, acousticQualification: 'unknown' };
  }
  requireCurrent(route: OutputRoute, generation: number): void {
    integer(generation, 1);
    invariant(this.profile.state === 'active' && this.profile.generation === generation &&
      canonicalJson(this.profile.route) === canonicalJson(route), 'ROUTE_PROFILE_CHANGED');
    this.lifecycle.requireCurrent(route);
  }
}
