import type { OutputRoute } from './contracts.js';
import { canonicalJson, identifier, integer, invariant } from './validation.js';

export type OutputLifecycleState = { state: 'unavailable' | 'interrupted'; generation: number } | { state: 'active'; generation: number; route: Readonly<OutputRoute>; playbackSupported: boolean; acousticQualification: 'unknown' };
/** Trusted native adapters report active routes; pairing lists and names are never evidence inputs. */
export class OutputLifecycle {
  private value: OutputLifecycleState = { state: 'unavailable', generation: 0 };
  constructor(private readonly invalidatePlaybackAndEvidence: () => void) {}
  snapshot(): OutputLifecycleState { return structuredClone(this.value); }
  active(route: OutputRoute, playbackSupported: boolean): void {
    identifier(route.endpointId); identifier(route.routeId); identifier(route.outputId); integer(route.generation, this.value.generation + 1);
    invariant(Object.keys(route).sort().join(',') === 'endpointId,generation,kind,outputId,routeId' && ['bluetooth-speaker','wired-speaker','headphones','internal','unknown'].includes(route.kind), 'INVALID_ACTIVE_ROUTE');
    invariant(typeof playbackSupported === 'boolean', 'INVALID_PLAYBACK_SUPPORT');
    const next: OutputLifecycleState = { state: 'active', generation: route.generation, route: Object.freeze(structuredClone(route)), playbackSupported, acousticQualification: 'unknown' };
    this.value = { state: 'unavailable', generation: route.generation }; this.invalidatePlaybackAndEvidence(); this.value = next;
  }
  interrupt(): void { const generation = this.value.generation + 1; integer(generation, 1); this.value = { state: 'interrupted', generation }; this.invalidatePlaybackAndEvidence(); }
  disconnect(): void { const generation = this.value.generation + 1; integer(generation, 1); this.value = { state: 'unavailable', generation }; this.invalidatePlaybackAndEvidence(); }
  requireCurrent(route: OutputRoute): void { invariant(this.value.state === 'active' && this.value.playbackSupported && canonicalJson(this.value.route) === canonicalJson(route), 'OUTPUT_ROUTE_CHANGED'); }
}
