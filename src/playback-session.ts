import type { ProgramPlayerOptions, PumpResult } from './player.js';
import { EndpointProgramPlayer } from './player.js';
import { PlaybackAuthority } from './safety.js';
import type { ControlPayloadDecoder } from './safety.js';
import type { ControlVerifier, SignedControl } from './controls.js';
import { AndroidAudioSink } from './android-audio.js';
import type { AndroidAudioBridge, AndroidSinkOptions } from './android-audio.js';
import { IOSAudioSink } from './ios-audio.js';
import type { IOSAudioBridge, IOSSinkOptions } from './ios-audio.js';
import { integer, invariant } from './validation.js';

export interface PlaybackSessionOptions extends Omit<ProgramPlayerOptions, 'sink'> {
  controls: ControlVerifier;
  /** A real authenticated E2EE parent decoder is required in an application. */
  decodeControlPayload: ControlPayloadDecoder;
  consentedGainCeiling: number;
}
export type AndroidPlaybackSessionOptions = PlaybackSessionOptions & {
  bridge: AndroidAudioBridge;
  native: Omit<AndroidSinkOptions, 'nowUnixMs' | 'onInvalidated'>;
};
export type IOSPlaybackSessionOptions = PlaybackSessionOptions & {
  bridge: IOSAudioBridge;
  native: Omit<IOSSinkOptions, 'nowUnixMs' | 'onInvalidated'>;
};
export type PlaybackSessionStopReason = 'user' | 'output-changed' | 'authority-expired' | 'emergency' | 'failure';
type NativeSink = AndroidAudioSink | IOSAudioSink;
type SinkFactory = (authority: PlaybackAuthority, invalidate: () => void) => NativeSink;

/** Owns the player, authority and native sink as one endpoint lifecycle.
 * No timers, networking, root provisioning, or invented key-establishment protocol.
 * The application explicitly joins and pumps; native envelopes enforce hard stops.
 */
export class EndpointPlaybackSession {
  private readonly authority: PlaybackAuthority;
  private readonly sink: NativeSink;
  private readonly player: EndpointProgramPlayer;
  private readonly nowUnixMs: () => number;
  private phase: 'idle' | 'authorizing' | 'playing' | 'stopped' | 'closed' = 'idle';
  private reason: PlaybackSessionStopReason | null = null;
  private generation = 0;
  private lastNowMs = 0;
  // Outstanding adapters cannot be forcibly cancelled. Bound outstanding work,
  // even if a decoder ignores cancellation or never settles.
  private leasePending = false;
  private emergencyPending = false;

  private constructor(options: PlaybackSessionOptions, createSink: SinkFactory) {
    invariant(options.controls.matchesScope(options.scope), 'SESSION_CONTROL_SCOPE_MISMATCH');
    this.nowUnixMs = options.nowUnixMs;
    this.authority = new PlaybackAuthority(options.controls, options.decodeControlPayload, options.consentedGainCeiling);
    this.authority.mute(true);
    this.sink = createSink(this.authority, () => this.invalidate('output-changed'));
    try { this.player = new EndpointProgramPlayer({ ...options, sink: this.sink }); }
    catch (error) { this.sink.close(); throw error; }
  }
  static android(options: AndroidPlaybackSessionOptions): EndpointPlaybackSession {
    return new EndpointPlaybackSession(options, (authority, onInvalidated) =>
      new AndroidAudioSink(options.bridge, authority, { ...options.native, nowUnixMs: options.nowUnixMs, onInvalidated }));
  }
  static ios(options: IOSPlaybackSessionOptions): EndpointPlaybackSession {
    return new EndpointPlaybackSession(options, (authority, onInvalidated) =>
      new IOSAudioSink(options.bridge, authority, { ...options.native, nowUnixMs: options.nowUnixMs, onInvalidated }));
  }
  snapshot() {
    return { phase: this.phase, generation: this.generation, stopReason: this.reason,
      output: this.sink.outputState(), pendingControls: Number(this.leasePending) + Number(this.emergencyPending) };
  }
  private now(): number {
    const now = this.nowUnixMs(); integer(now, this.lastNowMs); this.lastNowMs = now; return now;
  }
  private requireOpen(): void { invariant(this.phase !== 'closed', 'PLAYBACK_SESSION_CLOSED'); }
  private requireCurrent(generation: number): void {
    invariant(this.phase !== 'closed' && generation === this.generation, 'PLAYBACK_SESSION_SUPERSEDED');
  }
  private invalidate(reason: PlaybackSessionStopReason): void {
    if (this.phase === 'closed') return;
    this.generation++; this.phase = 'stopped'; this.reason = reason;
    this.authority.leave();
    // A native bridge may report its current route synchronously in subscribe(),
    // before the player is constructed. Its own sink is already invalidating.
    this.player?.interrupt();
  }
  private failCurrent(generation: number): void {
    if (generation === this.generation) {
      try { this.invalidate('failure'); } catch { /* Keep the original failure; state is already revoked. */ }
    }
  }
  /** Explicit user-requested start/rejoin. Route return alone never starts output. */
  async join(control: SignedControl): Promise<void> {
    this.requireOpen();
    invariant(this.phase === 'idle' || this.phase === 'stopped', 'PLAYBACK_SESSION_ALREADY_STARTED');
    await this.applyLease(control, true);
  }
  /** Extends authority only for future PCM. Already queued native envelopes contract only. */
  async renew(control: SignedControl): Promise<void> {
    this.requireOpen(); invariant(this.phase === 'playing', 'PLAYBACK_SESSION_NOT_PLAYING');
    await this.applyLease(control, false);
  }
  private async applyLease(control: SignedControl, joining: boolean): Promise<void> {
    invariant(!this.leasePending && !this.emergencyPending, 'PLAYBACK_SESSION_CONTROL_BUSY');
    invariant(this.sink.outputState().state === 'active', 'PLAYBACK_SESSION_OUTPUT_UNAVAILABLE');
    const generation = this.generation;
    this.leasePending = true;
    if (joining) this.phase = 'authorizing';
    try {
      // Clone before the first await; callers cannot change the signed request.
      await this.authority.renew(structuredClone(control), this.now());
      this.requireCurrent(generation);
      if (joining) this.authority.mute(false);
      // Verification and private payload delivery may have taken arbitrarily long.
      invariant(this.authority.envelopeAt(this.now()), 'PLAYBACK_SESSION_AUTHORITY_EXPIRED');
      this.sink.refreshAuthority(); this.requireCurrent(generation);
      this.phase = 'playing'; this.reason = null;
    } catch (error) { this.failCurrent(generation); throw error; }
    finally { this.leasePending = false; }
  }
  /** A valid emergency stop can supersede a lease stalled in private payload delivery. */
  async emergencyStop(control: SignedControl): Promise<void> {
    this.requireOpen(); invariant(!this.emergencyPending, 'PLAYBACK_SESSION_CONTROL_BUSY');
    const generation = this.generation; this.emergencyPending = true;
    try {
      await this.authority.emergencyStop(structuredClone(control), this.now());
      this.requireCurrent(generation); this.invalidate('emergency');
    } catch (error) { this.failCurrent(generation); throw error; }
    finally { this.emergencyPending = false; }
  }
  async pump(): Promise<PumpResult> {
    this.requireOpen(); invariant(this.phase === 'playing', 'PLAYBACK_SESSION_NOT_PLAYING');
    const generation = this.generation;
    try {
      if (!this.authority.envelopeAt(this.now())) {
        this.invalidate('authority-expired'); throw new Error('PLAYBACK_SESSION_AUTHORITY_EXPIRED');
      }
      this.sink.refreshAuthority(); this.requireCurrent(generation);
      const result = await this.player.pump(); this.requireCurrent(generation); return result;
    } catch (error) { this.failCurrent(generation); throw error; }
  }
  setUserGain(gain: number): void {
    this.requireOpen(); const generation = this.generation;
    try {
      this.sink.setUserGain(gain);
      if (gain === 0) this.invalidate('user');
    } catch (error) { this.failCurrent(generation); throw error; }
  }
  stop(): void { this.invalidate('user'); }
  close(): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed'; this.generation++; this.authority.leave();
    try { this.player.close(); } finally { this.sink.close(); }
  }
}
