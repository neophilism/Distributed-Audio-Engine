import type { PcmAudio } from './media.js';
import { analyzePcm } from './media.js';
import { PlaybackAuthority } from './safety.js';
import type { OutputEnvelope } from './safety.js';
import { finite, identifier, integer, invariant } from './validation.js';

export interface BrowserSinkOptions {
  nowUnixMs: () => number;
  maxAheadMs?: number;
  maxQueuedSamples?: number;
}
interface Voice {
  id: string; source: AudioBufferSourceNode; gain: GainNode; buffer: AudioBuffer;
  startsAtMs: number; endsAtMs: number; samples: number;
}
/** Endpoint Web Audio sink. Browser scheduling is not calibrated acoustic output. */
export class BrowserAudioSink {
  private readonly voices = new Map<string, Voice>();
  private readonly maxAheadMs: number;
  private readonly maxQueuedSamples: number;
  private readonly nowUnixMs: () => number;
  private queuedSamples = 0;
  private closed = false;
  private readonly onStateChange = () => { this.stopAll(); };

  constructor(private readonly context: AudioContext, private readonly authority: PlaybackAuthority, options: BrowserSinkOptions) {
    this.maxAheadMs = options.maxAheadMs ?? 1000; this.maxQueuedSamples = options.maxQueuedSamples ?? 4 * 1024 * 1024;
    integer(this.maxAheadMs, 1, 5000); integer(this.maxQueuedSamples, 1, 16 * 1024 * 1024);
    this.nowUnixMs = options.nowUnixMs;
    context.addEventListener('statechange', this.onStateChange);
  }
  get pending(): number { return this.voices.size; }
  get horizonMs(): number { return this.maxAheadMs; }
  private observe() {
    invariant(!this.closed, 'AUDIO_SINK_CLOSED'); const nowMs = this.nowUnixMs(); integer(nowMs);
    invariant(Number.isFinite(this.context.currentTime) && this.context.currentTime >= 0, 'INVALID_AUDIO_CLOCK');
    return { nowMs, audioTime: this.context.currentTime };
  }
  private automate(voice: Voice, envelope: OutputEnvelope, nowMs: number, audioTime: number): void {
    const param = voice.gain.gain; param.cancelScheduledValues(audioTime);
    const fraction = Math.min(1, Math.max(0, (envelope.deadlineMs - nowMs) / (envelope.deadlineMs - envelope.fadeStartMs)));
    param.setValueAtTime(envelope.gainCeiling * fraction, audioTime);
    const fadeAt = audioTime + Math.max(0, envelope.fadeStartMs - nowMs) / 1000;
    if (fadeAt > audioTime) param.setValueAtTime(envelope.gainCeiling, fadeAt);
    param.linearRampToValueAtTime(0, audioTime + (envelope.deadlineMs - nowMs) / 1000);
  }
  private dispose(voice: Voice, stop: boolean): void {
    if (!this.voices.delete(voice.id)) return;
    this.queuedSamples -= voice.samples; voice.source.onended = null;
    // Disconnect first so cleanup failure cannot leave a live output path.
    voice.gain.disconnect(); voice.source.disconnect();
    if (stop) { try { voice.source.stop(); } catch { /* Source may already have ended. */ } }
    for (let channel = 0; channel < voice.buffer.numberOfChannels; channel++) voice.buffer.getChannelData(channel).fill(0);
  }
  schedule(id: string, audio: PcmAudio, targetUnixMs: number, offsetFrames = 0, requestedFrames = audio.samples.length / audio.channels - offsetFrames): { frames: number; startsAtMs: number; endsAtMs: number; alignment: 'timeline-only' } {
    identifier(id); const { nowMs, audioTime } = this.observe();
    invariant(this.context.state === 'running', 'AUDIO_CONTEXT_NOT_RUNNING');
    finite(targetUnixMs, nowMs, nowMs + this.maxAheadMs); const metadata = analyzePcm(audio);
    invariant(metadata.sampleRate === this.context.sampleRate, 'AUDIO_RATE_ADAPTER_REQUIRED');
    integer(offsetFrames, 0, metadata.frames - 1); integer(requestedFrames, 1, metadata.frames - offsetFrames);
    invariant(!this.voices.has(id) && this.voices.size < 64, 'AUDIO_QUEUE_CONFLICT');
    const envelope = this.authority.envelopeAt(nowMs); invariant(envelope, 'NO_PLAYBACK_AUTHORITY');
    const availableMs = Math.min(envelope.deadlineMs, nowMs + this.maxAheadMs) - targetUnixMs;
    const frames = Math.min(requestedFrames, Math.floor(availableMs * audio.sampleRate / 1000));
    invariant(frames > 0, 'NO_AUTHORIZED_OUTPUT_FRAMES');
    const endsAtMs = targetUnixMs + frames * 1000 / audio.sampleRate;
    for (const voice of this.voices.values()) invariant(endsAtMs <= voice.startsAtMs || targetUnixMs >= voice.endsAtMs, 'OVERLAPPING_AUDIO_OUTPUT');
    const samples = frames * audio.channels; invariant(this.queuedSamples + samples <= this.maxQueuedSamples, 'AUDIO_QUEUE_LIMIT');
    const buffer = this.context.createBuffer(audio.channels, frames, audio.sampleRate);
    for (let channel = 0; channel < audio.channels; channel++) {
      const data = new Float32Array(frames);
      for (let i = 0; i < frames; i++) data[i] = audio.samples[(offsetFrames + i) * audio.channels + channel]!;
      buffer.copyToChannel(data, channel); data.fill(0);
    }
    const source = this.context.createBufferSource(); const gain = this.context.createGain(); source.buffer = buffer;
    const voice: Voice = { id, source, gain, buffer, startsAtMs: targetUnixMs, endsAtMs, samples };
    this.voices.set(id, voice); this.queuedSamples += samples;
    try {
      source.connect(gain); gain.connect(this.context.destination); this.automate(voice, envelope, nowMs, audioTime);
      source.onended = () => this.dispose(voice, false);
      const at = audioTime + (targetUnixMs - nowMs) / 1000;
      source.start(at, 0, frames / audio.sampleRate);
      source.stop(audioTime + (endsAtMs - nowMs) / 1000);
      return { frames, startsAtMs: targetUnixMs, endsAtMs, alignment: 'timeline-only' };
    } catch (error) { this.dispose(voice, true); throw error; }
  }
  /** Invoke after a lease change or emergency control; deadlines are already in the graph. */
  refreshAuthority(): void {
    const { nowMs, audioTime } = this.observe(); const envelope = this.authority.envelopeAt(nowMs);
    if (!envelope || this.context.state !== 'running') { this.stopAll(); return; }
    for (const voice of [...this.voices.values()]) {
      if (voice.endsAtMs <= nowMs || voice.startsAtMs >= envelope.deadlineMs) { this.dispose(voice, true); continue; }
      this.automate(voice, envelope, nowMs, audioTime);
      // Never extend already queued output when renewing a lease.
      voice.source.stop(audioTime + (Math.min(voice.endsAtMs, envelope.deadlineMs) - nowMs) / 1000);
    }
  }
  setUserGain(gain: number): void { this.authority.setUserGain(gain); this.refreshAuthority(); }
  mute(muted = true): void { this.authority.mute(muted); this.refreshAuthority(); }
  invalidateRoute(): void { this.stopAll(); }
  stopAll(): void { for (const voice of [...this.voices.values()]) this.dispose(voice, true); }
  leave(): void { this.authority.leave(); this.stopAll(); }
  close(): void { if (this.closed) return; this.leave(); this.context.removeEventListener('statechange', this.onStateChange); this.closed = true; }
}
