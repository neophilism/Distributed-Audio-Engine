import type { OutputRoute } from './contracts.js';
import type { PcmAudio } from './media.js';
import { analyzePcm } from './media.js';
import { OutputLifecycle } from './output-lifecycle.js';
import type { PlaybackAuthority } from './safety.js';
import { canonicalJson, finite, identifier, integer, invariant } from './validation.js';

export type AndroidInterruptionReason = 'focus-loss' | 'becoming-noisy' | 'call' | 'app-suspended' | 'service-destroyed';
export type AndroidAudioEvent =
  | { type: 'route-active'; route: OutputRoute; sampleRate: number; maxChannels: number }
  | { type: 'interrupted'; reason: AndroidInterruptionReason }
  | { type: 'disconnected' }
  | { type: 'completed'; id: string };

export interface AndroidPcmRequest {
  /** Opaque per-dispatch identity; echo it in completion events, never a clip label. */
  id: string;
  routeGeneration: number;
  samples: Float32Array;
  sampleRate: number;
  channels: number;
  frames: number;
  startAtMonotonicMs: number;
  gainCeiling: number;
  fadeStartMonotonicMs: number;
  stopAtMonotonicMs: number;
}

export interface AndroidAudioBridge {
  /** Events must originate from AudioManager/AudioTrack state, never paired-device names. */
  subscribe(listener: (event: AndroidAudioEvent) => void): () => void;
  /** Copy PCM into bounded native-owned storage before returning; the SDK wipes this temporary view. */
  enqueue(request: Readonly<AndroidPcmRequest>): void;
  updateEnvelope(id: string, gainCeiling: number, fadeStartMonotonicMs: number, stopAtMonotonicMs: number): void;
  cancel(id: string): void;
  cancelAll(): void;
}

export interface AndroidSinkOptions {
  nowUnixMs: () => number;
  nowMonotonicMs: () => number;
  /** Revokes the owning endpoint session on route/lifecycle invalidation. */
  onInvalidated?: () => void;
  maxAheadMs?: number;
  maxQueuedSamples?: number;
}

interface AndroidFormat { route: Readonly<OutputRoute>; sampleRate: number; maxChannels: number }
interface Voice {
  id: string;
  nativeId: string;
  gainCeiling: number;
  nativeFadeStartMs: number;
  nativeDeadlineMs: number;
  startsAtMs: number;
  endsAtMs: number;
  fadeStartMs: number;
  deadlineMs: number;
  samples: number;
}

/** Android host binding. Portable tests do not establish AudioTrack or device compatibility. */
export class AndroidAudioSink {
  private readonly maxAheadMs: number;
  private readonly maxQueuedSamples: number;
  private readonly lifecycle: OutputLifecycle;
  private readonly voices = new Map<string, Voice>();
  private readonly nativeVoices = new Map<string, string>();
  private readonly dispatchPrefix = globalThis.crypto.randomUUID();
  private nextDispatch = 0;
  private readonly unsubscribe: () => void;
  private format: AndroidFormat | undefined;
  private queuedSamples = 0;
  private lastUnixMs = 0;
  private lastMonotonicMs = 0;
  private closed = false;

  constructor(private readonly bridge: AndroidAudioBridge, private readonly authority: PlaybackAuthority, private readonly options: AndroidSinkOptions) {
    this.maxAheadMs = options.maxAheadMs ?? 1000;
    this.maxQueuedSamples = options.maxQueuedSamples ?? 4 * 1024 * 1024;
    integer(this.maxAheadMs, 1, 5000);
    integer(this.maxQueuedSamples, 1, 16 * 1024 * 1024);
    this.lifecycle = new OutputLifecycle(() => {
      try { this.stopAll(); } finally { options.onInvalidated?.(); }
    });
    this.unsubscribe = bridge.subscribe(event => {
      try { this.onEvent(event); }
      catch (error) {
        // An invalid native callback must not leave previously authorized PCM queued.
        // The host may already be faulted; revoke JavaScript authority regardless of
        // whether its best-effort native cancellation throws.
        this.format = undefined;
        this.authority.leave();
        try { this.lifecycle.interrupt(); } catch { /* Local lifecycle state is interrupted before callbacks. */ }
        try { this.bridge.cancelAll(); } catch { /* Native driver may be unavailable. */ }
        throw error;
      }
    });
    invariant(typeof this.unsubscribe === 'function', 'INVALID_ANDROID_SUBSCRIPTION');
  }

  get horizonMs(): number { return this.maxAheadMs; }
  get pending(): number { return this.voices.size; }
  outputState() { return this.lifecycle.snapshot(); }

  private observe(): { nowMs: number; monotonicMs: number } {
    invariant(!this.closed, 'ANDROID_AUDIO_SINK_CLOSED');
    const nowMs = this.options.nowUnixMs(), monotonicMs = this.options.nowMonotonicMs();
    try { integer(nowMs, this.lastUnixMs); finite(monotonicMs, this.lastMonotonicMs); }
    catch (error) { this.format = undefined; this.lifecycle.interrupt(); throw error; }
    this.lastUnixMs = nowMs; this.lastMonotonicMs = monotonicMs;
    return { nowMs, monotonicMs };
  }

  private onEvent(event: AndroidAudioEvent): void {
    if (this.closed) return;
    invariant(event && typeof event === 'object', 'INVALID_ANDROID_AUDIO_EVENT');
    if (event.type === 'route-active') {
      invariant(Object.keys(event).sort().join(',') === 'maxChannels,route,sampleRate,type', 'INVALID_ANDROID_AUDIO_EVENT');
      integer(event.sampleRate, 8000, 192000); integer(event.maxChannels, 1, 8);
      const current = this.lifecycle.snapshot();
      if (current.state === 'active' && this.format && canonicalJson(current.route) === canonicalJson(event.route) &&
        this.format.sampleRate === event.sampleRate && this.format.maxChannels === event.maxChannels) return;
      this.format = undefined;
      this.lifecycle.active(event.route, true);
      this.format = { route: Object.freeze(structuredClone(event.route)), sampleRate: event.sampleRate, maxChannels: event.maxChannels };
      return;
    }
    if (event.type === 'completed') {
      invariant(Object.keys(event).sort().join(',') === 'id,type', 'INVALID_ANDROID_AUDIO_EVENT');
      identifier(event.id); this.complete(event.id); return;
    }
    if (event.type === 'interrupted') {
      invariant(Object.keys(event).sort().join(',') === 'reason,type' &&
        ['focus-loss','becoming-noisy','call','app-suspended','service-destroyed'].includes(event.reason), 'INVALID_ANDROID_AUDIO_EVENT');
      this.format = undefined; this.lifecycle.interrupt(); return;
    }
    invariant(event.type === 'disconnected' && Object.keys(event).sort().join(',') === 'type', 'INVALID_ANDROID_AUDIO_EVENT');
    this.format = undefined; this.lifecycle.disconnect();
  }

  private complete(nativeId: string): void {
    const id = this.nativeVoices.get(nativeId);
    if (!id) return;
    const voice = this.voices.get(id);
    if (!voice || voice.nativeId !== nativeId) return;
    this.nativeVoices.delete(nativeId);
    this.voices.delete(id); this.queuedSamples -= voice.samples;
  }

  private cancel(voice: Voice): void {
    if (this.voices.get(voice.id) !== voice) return;
    this.voices.delete(voice.id); this.nativeVoices.delete(voice.nativeId);
    this.queuedSamples -= voice.samples;
    this.bridge.cancel(voice.nativeId);
  }

  schedule(id: string, audio: PcmAudio, targetUnixMs: number, offsetFrames = 0, requestedFrames = audio.samples.length / audio.channels - offsetFrames) {
    identifier(id);
    const { nowMs, monotonicMs } = this.observe();
    finite(targetUnixMs, nowMs, nowMs + this.maxAheadMs);
    const state = this.lifecycle.snapshot(), format = this.format;
    invariant(state.state === 'active' && format, 'ANDROID_OUTPUT_UNAVAILABLE');
    this.lifecycle.requireCurrent(format.route);
    const metadata = analyzePcm(audio);
    invariant(metadata.sampleRate === format.sampleRate, 'ANDROID_RATE_ADAPTER_REQUIRED');
    // The shipped AudioTrack/JNI host owns a queue with exactly the announced
    // channel count; a smaller count is not an implicit native upmix.
    invariant(metadata.channels === format.maxChannels, 'ANDROID_CHANNEL_ADAPTER_REQUIRED');
    integer(offsetFrames, 0, metadata.frames - 1); integer(requestedFrames, 1, metadata.frames - offsetFrames);
    invariant(!this.voices.has(id) && this.voices.size < 64, 'ANDROID_AUDIO_QUEUE_CONFLICT');
    const envelope = this.authority.envelopeAt(nowMs); invariant(envelope, 'NO_PLAYBACK_AUTHORITY');
    const availableMs = Math.min(envelope.deadlineMs, nowMs + this.maxAheadMs) - targetUnixMs;
    const frames = Math.min(requestedFrames, Math.floor(availableMs * audio.sampleRate / 1000));
    invariant(frames > 0, 'NO_AUTHORIZED_OUTPUT_FRAMES');
    const endsAtMs = targetUnixMs + frames * 1000 / audio.sampleRate;
    for (const voice of this.voices.values()) invariant(endsAtMs <= voice.startsAtMs || targetUnixMs >= voice.endsAtMs, 'OVERLAPPING_ANDROID_OUTPUT');
    const samples = frames * audio.channels;
    invariant(this.queuedSamples + samples <= this.maxQueuedSamples, 'ANDROID_AUDIO_QUEUE_LIMIT');
    const pcm = audio.samples.slice(offsetFrames * audio.channels, (offsetFrames + frames) * audio.channels);
    const deadlineMs = Math.min(endsAtMs, envelope.deadlineMs);
    integer(++this.nextDispatch, 1);
    const nativeId = `${this.dispatchPrefix}-${this.nextDispatch}`;
    const nativeFadeStartMs = monotonicMs + Math.max(0, envelope.fadeStartMs - nowMs);
    const nativeDeadlineMs = monotonicMs + deadlineMs - nowMs;
    const voice: Voice = { id, nativeId, gainCeiling: envelope.gainCeiling, nativeFadeStartMs, nativeDeadlineMs,
      startsAtMs: targetUnixMs, endsAtMs, fadeStartMs: envelope.fadeStartMs, deadlineMs, samples };
    this.voices.set(id, voice); this.nativeVoices.set(nativeId, id); this.queuedSamples += samples;
    try {
      this.bridge.enqueue({
        id: nativeId, routeGeneration: format.route.generation,
        samples: pcm, sampleRate: audio.sampleRate, channels: audio.channels, frames,
        startAtMonotonicMs: monotonicMs + targetUnixMs - nowMs,
        gainCeiling: envelope.gainCeiling,
        fadeStartMonotonicMs: nativeFadeStartMs,
        stopAtMonotonicMs: nativeDeadlineMs
      });
    } catch (error) {
      if (this.voices.get(id) === voice) {
        this.voices.delete(id); this.nativeVoices.delete(nativeId); this.queuedSamples -= samples;
      }
      try { this.bridge.cancel(nativeId); } catch { /* Local state is already fail-closed. */ }
      throw error;
    } finally { pcm.fill(0); }
    return { frames, startsAtMs: targetUnixMs, endsAtMs, alignment: 'timeline-only' as const };
  }

  /** Apply reduced authority immediately; a renewal never extends queued native output. */
  refreshAuthority(): void {
    const { nowMs, monotonicMs } = this.observe();
    const envelope = this.authority.envelopeAt(nowMs);
    if (!envelope) { this.stopAll(); return; }
    try {
      for (const voice of [...this.voices.values()]) {
        if (voice.endsAtMs <= nowMs || voice.startsAtMs >= envelope.deadlineMs) { this.cancel(voice); continue; }
        voice.deadlineMs = Math.min(voice.deadlineMs, envelope.deadlineMs);
        voice.fadeStartMs = Math.min(voice.fadeStartMs, envelope.fadeStartMs, voice.deadlineMs);
        voice.gainCeiling = Math.min(voice.gainCeiling, envelope.gainCeiling);
        voice.nativeFadeStartMs = Math.min(voice.nativeFadeStartMs, monotonicMs + Math.max(0, voice.fadeStartMs - nowMs));
        voice.nativeDeadlineMs = Math.min(voice.nativeDeadlineMs, monotonicMs + voice.deadlineMs - nowMs);
        this.bridge.updateEnvelope(voice.nativeId, voice.gainCeiling, voice.nativeFadeStartMs, voice.nativeDeadlineMs);
      }
    } catch (error) { this.stopAll(); throw error; }
  }

  setUserGain(gain: number): void { this.authority.setUserGain(gain); this.refreshAuthority(); }
  mute(muted = true): void { this.authority.mute(muted); this.refreshAuthority(); }
  stopAll(): void {
    this.voices.clear(); this.nativeVoices.clear(); this.queuedSamples = 0;
    this.bridge.cancelAll();
  }
  leave(): void { this.authority.leave(); this.stopAll(); }
  close(): void {
    if (this.closed) return;
    this.closed = true; this.format = undefined; this.authority.leave();
    try { this.lifecycle.disconnect(); } finally { this.unsubscribe(); }
  }
}
