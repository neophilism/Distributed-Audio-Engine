import type { Scope } from './contracts.js';
import { EndpointAttachmentReader } from './attachments.js';
import type { AttachmentContext, PrivateManifest } from './attachments.js';
import { readAttachmentRange } from './delivery.js';
import type { CiphertextChunkTransport } from './delivery.js';
import { analyzePcm, decodeWave } from './media.js';
import type { PcmAudio } from './media.js';
import { ProgramTimeline } from './timeline.js';
import { identifier, integer, invariant } from './validation.js';

/** Private descriptor authenticated alongside the manifest in the endpoint E2EE channel. */
export interface EndpointMediaAsset {
  assetId: string;
  context: AttachmentContext;
  manifest: PrivateManifest;
  sampleRate: number;
  channels: number;
  frames: number;
  authorizationValidUntilMs: number;
}
export interface EndpointAssetResolver {
  /** Must enforce current recipient membership; never use a plaintext service manifest fallback. */
  resolve(assetId: string, scope: Readonly<Scope>, signal: AbortSignal): Promise<EndpointMediaAsset>;
}
export interface PcmPlaybackSink {
  readonly horizonMs: number;
  schedule(id: string, audio: PcmAudio, targetUnixMs: number, offsetFrames: number, frames: number): { frames: number; startsAtMs: number; endsAtMs: number; alignment: 'timeline-only' };
  stopAll(): void;
}
export interface ProgramPlayerOptions {
  scope: Scope;
  timeline: ProgramTimeline;
  resolver: EndpointAssetResolver;
  transport: CiphertextChunkTransport;
  sink: PcmPlaybackSink;
  nowUnixMs: () => number;
  /** Trusted endpoint rights adapter. Rechecked immediately before each scheduling operation. */
  authorizePlayback: (assetId: string, atMs: number, signal: AbortSignal) => Promise<EndpointPlaybackPermission>;
  leadMs?: number;
}
export type EndpointPlaybackPermission = { allowed: false } | { allowed: true; validUntilMs: number };
export type PumpResult = { status: 'scheduled'; assetId: string; absoluteFrame: bigint; frames: number; alignment: 'timeline-only' } | { status: 'busy' | 'buffered' | 'retry-current-target' };
interface CachedAsset { descriptor: EndpointMediaAsset; audio: PcmAudio }

/** Linear current-position playback. No caller-selected clip, seek or personalized insertion API. */
export class EndpointProgramPlayer {
  private readonly options: ProgramPlayerOptions;
  private readonly leadMs: number;
  private cached: CachedAsset | undefined;
  private cursor: bigint | undefined;
  private abort: AbortController | undefined;
  private generation = 0;
  private scheduleSequence = 0;
  private closed = false;
  private lastNowMs = 0;
  constructor(options: ProgramPlayerOptions) {
    identifier(options.scope.tenantId); identifier(options.scope.sessionId);
    invariant(options.scope.application === 'scenesignal' || options.scope.application === 'distributed-radio', 'INVALID_APPLICATION');
    this.leadMs = options.leadMs ?? 50; integer(this.leadMs, 1, 500);
    integer(options.sink.horizonMs, this.leadMs + 1, 5000);
    this.options = { ...options, scope: Object.freeze({ ...options.scope }) };
  }
  private now(): number {
    const now = this.options.nowUnixMs(); integer(now, this.lastNowMs); this.lastNowMs = now; return now;
  }
  private clearCache(): void { this.cached?.audio.samples.fill(0); this.cached = undefined; }
  private check(generation: number, signal: AbortSignal): void { invariant(!this.closed && !signal.aborted && this.generation === generation, 'PLAYBACK_OPERATION_SUPERSEDED'); }
  private target(nowMs: number) {
    const current = this.options.timeline.frameAt(nowMs + this.leadMs);
    return this.options.timeline.targetAtFrame(this.cursor !== undefined && this.cursor > current ? this.cursor : current);
  }
  private validateDescriptor(descriptor: EndpointMediaAsset, assetId: string, nowMs: number): void {
    invariant(Object.keys(descriptor).sort().join(',') === 'assetId,authorizationValidUntilMs,channels,context,frames,manifest,sampleRate', 'INVALID_ASSET_DESCRIPTOR');
    invariant(descriptor.assetId === assetId && descriptor.context.tenantId === this.options.scope.tenantId && descriptor.context.application === this.options.scope.application, 'ASSET_SCOPE_MISMATCH');
    identifier(descriptor.context.parentMessageId); integer(descriptor.sampleRate, 8000, 192000); integer(descriptor.channels, 1, 8); integer(descriptor.frames, 1);
    integer(descriptor.authorizationValidUntilMs, nowMs + 1, nowMs + 300000);
    invariant(descriptor.manifest.mediaType === 'audio/wav', 'UNSUPPORTED_ENDPOINT_CODEC');
  }
  private permissionUntil(permission: EndpointPlaybackPermission, nowMs: number): number {
    invariant(permission.allowed === true, 'PLAYBACK_RIGHTS_DENIED');
    invariant(Object.keys(permission).sort().join(',') === 'allowed,validUntilMs', 'INVALID_PLAYBACK_PERMISSION');
    integer(permission.validUntilMs, nowMs + 1, nowMs + 300000); return permission.validUntilMs;
  }
  async pump(): Promise<PumpResult> {
    invariant(!this.closed, 'PLAYER_CLOSED'); if (this.abort) return { status: 'busy' };
    const abort = new AbortController(); this.abort = abort; const generation = this.generation;
    let decoded: PcmAudio | undefined;
    try {
      const initialNow = this.now(); const initial = this.target(initialNow);
      if (this.options.timeline.timeAtFrame(initial.absoluteFrame) >= initialNow + this.options.sink.horizonMs - 1) return { status: 'buffered' };
      const initialPermission = await this.options.authorizePlayback(initial.assetId, initialNow, abort.signal); this.check(generation, abort.signal);
      this.permissionUntil(initialPermission, this.now());
      if (!this.cached || this.cached.descriptor.assetId !== initial.assetId || this.cached.descriptor.authorizationValidUntilMs <= initialNow + this.leadMs) {
        this.clearCache();
        const descriptor = structuredClone(await this.options.resolver.resolve(initial.assetId, this.options.scope, abort.signal)); this.check(generation, abort.signal);
        this.validateDescriptor(descriptor, initial.assetId, this.now());
        const reader = await EndpointAttachmentReader.open(descriptor.manifest, descriptor.context);
        try {
          this.check(generation, abort.signal);
          const result = await readAttachmentRange(reader, this.options.transport, 0, reader.sizeBytes, { signal: abort.signal });
          try { this.check(generation, abort.signal); decoded = decodeWave(result.plaintext); }
          finally { result.plaintext.fill(0); }
        } finally { reader.close(); }
        const metadata = analyzePcm(decoded);
        invariant(metadata.sampleRate === descriptor.sampleRate && metadata.channels === descriptor.channels && metadata.frames === descriptor.frames, 'ASSET_METADATA_MISMATCH');
        this.cached = { descriptor, audio: decoded }; decoded = undefined;
      }
      const beforePermission = this.now(); const candidate = this.target(beforePermission);
      if (candidate.assetId !== this.cached.descriptor.assetId) { this.clearCache(); return { status: 'retry-current-target' }; }
      const permission = await this.options.authorizePlayback(candidate.assetId, beforePermission, abort.signal); this.check(generation, abort.signal);
      // Authorization and delivery can take time. Resolve the live target after the final await.
      const now = this.now(); const rightsUntilMs = this.permissionUntil(permission, now); const target = this.target(now); const cache = this.cached;
      if (target.assetId !== cache.descriptor.assetId) { this.clearCache(); return { status: 'retry-current-target' }; }
      const startsAtMs = this.options.timeline.timeAtFrame(target.absoluteFrame);
      if (startsAtMs >= now + this.options.sink.horizonMs - 1) return { status: 'buffered' };
      const validUntilMs = Math.min(cache.descriptor.authorizationValidUntilMs, rightsUntilMs);
      invariant(validUntilMs > startsAtMs, 'ASSET_AUTHORIZATION_EXPIRED');
      invariant(cache.descriptor.frames === target.clipFrames && cache.descriptor.sampleRate === target.sampleRate, 'TIMELINE_ASSET_MISMATCH');
      const authorizedFrames = Math.floor((validUntilMs - startsAtMs) * target.sampleRate / 1000);
      const frames = Math.min(target.remainingFrames, authorizedFrames); invariant(frames > 0, 'ASSET_AUTHORIZATION_EXPIRED');
      const result = this.options.sink.schedule(`playback-${++this.scheduleSequence}`, cache.audio, startsAtMs, target.offsetFrames, frames);
      integer(result.frames, 1, frames);
      this.cursor = target.absoluteFrame + BigInt(result.frames);
      return { status: 'scheduled', assetId: target.assetId, absoluteFrame: target.absoluteFrame, frames: result.frames, alignment: 'timeline-only' };
    } catch (error) {
      // An older canceled operation must not stop a newer playback generation.
      if (generation === this.generation) this.interrupt();
      throw error;
    } finally { decoded?.samples.fill(0); if (this.abort === abort) this.abort = undefined; }
  }
  /** Call before lifecycle/output changes. Late fetches cannot rearm output. */
  interrupt(): void { this.generation++; this.abort?.abort(); this.abort = undefined; this.cursor = undefined; this.clearCache(); this.options.sink.stopAll(); }
  close(): void { if (this.closed) return; this.interrupt(); this.closed = true; }
}
