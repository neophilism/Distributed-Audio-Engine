import type { Scope } from './contracts.js';
import { ControlVerifier } from './controls.js';
import type { SignedControl } from './controls.js';
import type { ControlPayloadDecoder } from './safety.js';
import { canonicalJson, finite, identifier, integer, invariant } from './validation.js';

export interface ClockProbe { nonce: string; sentMonoMs: number }
export interface ClockResponse { nonce: string; receivedUnixMs: number; sentUnixMs: number; uncertaintyMs: number }
export interface ClockPolicy {
  maxRoundTripMs: number; maxSampleAgeMs: number; maxDriftPpm: number;
  localResolutionMs: number; maxServerUncertaintyMs: number; minSamples: number;
}
interface ClockSample { localMidMs: number; remoteMidMs: number; uncertaintyMs: number; roundTripMs: number; receivedMonoMs: number }
export type ClockEstimate = { state: 'unavailable'; reason: 'INSUFFICIENT_SAMPLES' | 'STALE_SAMPLES' | 'INCONSISTENT_SAMPLES' } | {
  state: 'usable'; unixMs: number; lowerUnixMs: number; upperUnixMs: number;
  uncertaintyMs: number; samples: number; driftEstimatePpm: number | null; assurance: 'network-clock-only';
};
const defaultPolicy: ClockPolicy = { maxRoundTripMs: 2000, maxSampleAgeMs: 15000, maxDriftPpm: 500, localResolutionMs: 1, maxServerUncertaintyMs: 50, minSamples: 3 };

/** Bounded time estimation over existing signed/E2EE controls, not a new key or NTP transport protocol. */
export class DisciplinedClock {
  private readonly scope: Scope;
  private readonly policy: ClockPolicy;
  private readonly samples: ClockSample[] = [];
  private pending: ClockProbe | undefined;
  private generation = 0;
  private lastMonoMs = 0;
  private lastReturnedUnixMs: number | undefined;
  constructor(scope: Scope, private readonly verifier: ControlVerifier, private readonly decode: ControlPayloadDecoder, private readonly monotonicNowMs: () => number, policy: Partial<ClockPolicy> = {}) {
    identifier(scope.tenantId); identifier(scope.sessionId); this.scope = { ...scope }; this.policy = { ...defaultPolicy, ...policy };
    invariant(scope.application === 'scenesignal' || scope.application === 'distributed-radio', 'INVALID_APPLICATION');
    invariant(verifier.matchesScope(scope), 'CLOCK_SCOPE_MISMATCH');
    const p = this.policy; integer(p.maxRoundTripMs, 1, 5000); integer(p.maxSampleAgeMs, p.maxRoundTripMs, 60000);
    finite(p.maxDriftPpm, 1, 1000); finite(p.localResolutionMs, 0.001, 100); finite(p.maxServerUncertaintyMs, 0, 1000); integer(p.minSamples, 1, 8);
  }
  private mono(): number { const now = this.monotonicNowMs(); finite(now, this.lastMonoMs, Number.MAX_SAFE_INTEGER); this.lastMonoMs = now; return now; }
  beginProbe(): ClockProbe {
    const sentMonoMs = this.mono(); const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join('');
    this.generation++; this.pending = { nonce, sentMonoMs }; return { ...this.pending };
  }
  private interval(sample: ClockSample, nowMonoMs: number) {
    const age = nowMonoMs - sample.localMidMs; const center = sample.remoteMidMs + age;
    const error = sample.uncertaintyMs + age * this.policy.maxDriftPpm / 1000000;
    return { lower: center - error, upper: center + error };
  }
  async accept(control: SignedControl, validationUnixMs: number): Promise<void> {
    const receivedMonoMs = this.mono(); const probe = this.pending; const generation = this.generation;
    invariant(probe && control.body.action === 'clock-response', 'NO_PENDING_CLOCK_PROBE_OR_WRONG_ACTION');
    const body = await this.verifier.accept(control, validationUnixMs);
    invariant(generation === this.generation && this.pending?.nonce === probe.nonce, 'CLOCK_PROBE_SUPERSEDED');
    invariant(canonicalJson(body.scope) === canonicalJson(this.scope), 'CLOCK_SCOPE_MISMATCH');
    const payload = await this.decode(body);
    invariant(generation === this.generation && this.pending?.nonce === probe.nonce, 'CLOCK_PROBE_SUPERSEDED');
    this.pending = undefined;
    invariant(payload && typeof payload === 'object' && Object.keys(payload).sort().join(',') === 'nonce,receivedUnixMs,sentUnixMs,uncertaintyMs', 'INVALID_CLOCK_RESPONSE');
    const response = structuredClone(payload) as ClockResponse;
    invariant(response.nonce === probe.nonce, 'CLOCK_CHALLENGE_MISMATCH'); finite(response.receivedUnixMs, 0, Number.MAX_SAFE_INTEGER); finite(response.sentUnixMs, response.receivedUnixMs, Number.MAX_SAFE_INTEGER);
    finite(response.uncertaintyMs, 0, this.policy.maxServerUncertaintyMs);
    const elapsed = receivedMonoMs - probe.sentMonoMs; finite(elapsed, 0, this.policy.maxRoundTripMs);
    const processing = response.sentUnixMs - response.receivedUnixMs;
    const precisionError = this.policy.localResolutionMs + response.uncertaintyMs + elapsed * this.policy.maxDriftPpm / 1000000;
    invariant(processing <= elapsed + 2 * precisionError, 'IMPOSSIBLE_CLOCK_TIMESTAMPS');
    const roundTripMs = Math.max(0, elapsed - processing);
    const sample: ClockSample = { localMidMs: probe.sentMonoMs + elapsed / 2, remoteMidMs: response.receivedUnixMs + processing / 2, uncertaintyMs: roundTripMs / 2 + precisionError, roundTripMs, receivedMonoMs };
    const now = this.mono(); invariant(now - receivedMonoMs <= this.policy.maxSampleAgeMs, 'STALE_CLOCK_RESPONSE');
    const recent = this.samples.filter(s => now - s.receivedMonoMs <= this.policy.maxSampleAgeMs);
    const candidate = this.interval(sample, now); let lower = candidate.lower; let upper = candidate.upper;
    for (const prior of recent) { const interval = this.interval(prior, now); lower = Math.max(lower, interval.lower); upper = Math.min(upper, interval.upper); }
    invariant(lower <= upper, 'CLOCK_SAMPLE_CONFLICT');
    this.samples.splice(0, this.samples.length, ...recent.slice(-7), sample);
  }
  estimate(): ClockEstimate {
    const now = this.mono(); const recent = this.samples.filter(s => now - s.receivedMonoMs <= this.policy.maxSampleAgeMs);
    if (recent.length < this.policy.minSamples) return { state: 'unavailable', reason: this.samples.length >= this.policy.minSamples ? 'STALE_SAMPLES' : 'INSUFFICIENT_SAMPLES' };
    let lower = -Infinity; let upper = Infinity;
    for (const sample of recent) { const interval = this.interval(sample, now); lower = Math.max(lower, interval.lower); upper = Math.min(upper, interval.upper); }
    if (lower > upper) return { state: 'unavailable', reason: 'INCONSISTENT_SAMPLES' };
    const rates: number[] = [];
    for (let i = 0; i < recent.length; i++) for (let j = i + 1; j < recent.length; j++) {
      const a = recent[i]!; const b = recent[j]!; const span = b.localMidMs - a.localMidMs;
      if (span >= 1000) { const ppm = ((b.remoteMidMs - a.remoteMidMs) / span - 1) * 1000000; if (Math.abs(ppm) <= this.policy.maxDriftPpm) rates.push(ppm); }
    }
    rates.sort((a, b) => a - b);
    return { state: 'usable', unixMs: lower + (upper - lower) / 2, lowerUnixMs: lower, upperUnixMs: upper, uncertaintyMs: (upper - lower) / 2, samples: recent.length, driftEstimatePpm: rates.length ? rates[Math.floor(rates.length / 2)]! : null, assurance: 'network-clock-only' };
  }
  /** No backwards steps. Large corrections require an explicit stop/reset/rejoin by the caller. */
  nowUnixMs(maxUncertaintyMs = 50): number {
    finite(maxUncertaintyMs, 0.001, 1000); const estimate = this.estimate(); invariant(estimate.state === 'usable', 'CLOCK_NOT_READY');
    const value = Math.max(this.lastReturnedUnixMs ?? 0, Math.floor(estimate.unixMs));
    integer(value);
    invariant(value <= estimate.upperUnixMs, 'CLOCK_CORRECTION_REJOIN_REQUIRED');
    invariant(Math.max(value - estimate.lowerUnixMs, estimate.upperUnixMs - value) <= maxUncertaintyMs, 'CLOCK_UNCERTAINTY_TOO_HIGH');
    this.lastReturnedUnixMs = value; return value;
  }
  reset(): void { this.generation++; this.pending = undefined; this.samples.length = 0; this.lastReturnedUnixMs = undefined; }
}
