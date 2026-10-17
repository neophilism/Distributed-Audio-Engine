import type { PcmAudio } from './media.js';
import type { Scope } from './contracts.js';
import { packageRendition } from './media.js';
import { finite, identifier, integer, invariant } from './validation.js';

/** Explicitly bounded foreground endpoint capture segmentation. A caller supplies
 * already authorized, format-matched PCM; this does not open a microphone, supply
 * E2EE identity, repair clock drift, or provide continuous network transport. */
export interface LivePcmSegmenterOptions {
  scope: Scope;
  streamId: string;
  sampleRate: number;
  channels: number;
  segmentFrames: number;
  startFrame?: bigint;
  /** Gain can only attenuate; never manipulates hardware volume. */
  gain?: number;
}
export interface EncryptedLivePcmSegment {
  segmentIndex: number;
  startFrame: bigint;
  frames: number;
  /** Only ciphertext is for relay upload; keep manifests and metadata private. */
  privateMetadata: Awaited<ReturnType<typeof packageRendition>>['privateMetadata'];
  privateManifest: Awaited<ReturnType<typeof packageRendition>>['privateManifest'];
  ciphertextChunks: Uint8Array[];
}
const MAX_SAMPLES = 2 * 1024 * 1024 / 4;
const MAX_SEGMENTS = 1_000_000;
function notAborted(signal?: AbortSignal): void {
  invariant(signal === undefined || signal instanceof AbortSignal, 'LIVE_INPUT_INVALID_SIGNAL');
  invariant(!signal?.aborted, 'LIVE_INPUT_ABORTED');
}
/** One bounded, strictly contiguous, fixed-format PCM source. Caller must provide
 * real-time scheduling/backpressure. Each completed segment gets a fresh E2E
 * attachment key and a distinct parent-message identifier. */
export class EncryptedLivePcmSegmenter {
  readonly sampleRate: number;
  readonly channels: number;
  readonly segmentFrames: number;
  private readonly scope: Scope;
  private readonly streamId: string;
  private readonly gain: number;
  private readonly buffer: Float32Array;
  private bufferedFrames = 0;
  private segmentStartFrame: bigint;
  private nextFrame: bigint;
  private nextSegment = 0;
  private busy = false;
  private closed = false;

  constructor(options: LivePcmSegmenterOptions) {
    invariant(options && typeof options === 'object' && options.scope, 'LIVE_INPUT_OPTIONS');
    identifier(options.scope.tenantId); identifier(options.scope.sessionId);
    invariant(['scenesignal', 'distributed-radio'].includes(options.scope.application), 'LIVE_INPUT_SCOPE');
    identifier(options.streamId);
    invariant(options.streamId.length <= 80, 'LIVE_INPUT_STREAM_ID_LIMIT');
    integer(options.sampleRate, 8000, 192000); integer(options.channels, 1, 8);
    integer(options.segmentFrames, 1, options.sampleRate);
    invariant(options.segmentFrames * options.channels <= MAX_SAMPLES, 'LIVE_INPUT_SEGMENT_LIMIT');
    const start = options.startFrame ?? 0n;
    invariant(typeof start === 'bigint' && start >= 0n, 'LIVE_INPUT_START_FRAME');
    this.gain = options.gain ?? 1; finite(this.gain, 0, 1);
    this.scope = Object.freeze({ tenantId: options.scope.tenantId,
      application: options.scope.application, sessionId: options.scope.sessionId });
    this.streamId = options.streamId;
    this.sampleRate = options.sampleRate; this.channels = options.channels;
    this.segmentFrames = options.segmentFrames;
    this.buffer = new Float32Array(options.segmentFrames * options.channels);
    this.segmentStartFrame = start; this.nextFrame = start;
  }

  snapshot() {
    return { closed: this.closed, busy: this.busy, nextFrame: this.nextFrame,
      pendingFrames: this.bufferedFrames, segmentsProduced: this.nextSegment };
  }
  private assertReady() { invariant(!this.closed && !this.busy, 'LIVE_INPUT_CLOSED_OR_BUSY'); }
  private wipeResult(value: EncryptedLivePcmSegment): void {
    value.privateManifest.attachmentKeyHex = '';
    for (const chunk of value.ciphertextChunks) chunk.fill(0);
  }
  private async encrypt(samples: Float32Array, frames: number, startFrame: bigint,
    signal?: AbortSignal): Promise<EncryptedLivePcmSegment> {
    invariant(this.nextSegment < MAX_SEGMENTS, 'LIVE_INPUT_SEGMENT_COUNT_LIMIT');
    const segmentIndex = this.nextSegment++;
    const context = { tenantId: this.scope.tenantId, application: this.scope.application,
      parentMessageId: `${this.streamId}-${segmentIndex}` };
    const audio: PcmAudio = { sampleRate: this.sampleRate, channels: this.channels, samples };
    notAborted(signal);
    const packaged = await packageRendition(audio, this.gain, context, `segment-${segmentIndex}.wav`);
    const result = { segmentIndex, startFrame, frames, ...packaged };
    try { invariant(!this.closed, 'LIVE_INPUT_CLOSED'); notAborted(signal); return result; }
    catch (error) { this.wipeResult(result); throw error; }
  }
  /** Frame index is an exact bigint source cursor; gaps, repeats and format changes
   * are rejected instead of inserting hidden silence or replayed PCM. */
  async push(frameStart: bigint, samples: Float32Array, signal?: AbortSignal): Promise<EncryptedLivePcmSegment[]> {
    this.assertReady(); notAborted(signal);
    invariant(typeof frameStart === 'bigint' && frameStart === this.nextFrame, 'LIVE_INPUT_FRAME_DISCONTINUITY');
    invariant(samples instanceof Float32Array && samples.buffer instanceof ArrayBuffer &&
      samples.length > 0 && samples.length % this.channels === 0, 'LIVE_INPUT_BUFFER_INVALID');
    const frames = samples.length / this.channels;
    integer(frames, 1, this.segmentFrames * 4);
    for (const value of samples) finite(value, -1, 1);
    const owned = Float32Array.from(samples);
    this.busy = true; this.nextFrame += BigInt(frames);
    const results: EncryptedLivePcmSegment[] = [];
    try {
      let read = 0;
      while (read < frames) {
        notAborted(signal);
        const copied = Math.min(frames - read, this.segmentFrames - this.bufferedFrames);
        this.buffer.set(owned.subarray(read * this.channels, (read + copied) * this.channels),
          this.bufferedFrames * this.channels);
        this.bufferedFrames += copied; read += copied;
        if (this.bufferedFrames === this.segmentFrames) {
          const segment = this.buffer.slice();
          const start = this.segmentStartFrame;
          this.buffer.fill(0); this.bufferedFrames = 0;
          this.segmentStartFrame += BigInt(this.segmentFrames);
          try { results.push(await this.encrypt(segment, this.segmentFrames, start, signal)); }
          finally { segment.fill(0); }
        }
      }
      notAborted(signal);
      return results;
    } catch (error) {
      for (const result of results) this.wipeResult(result);
      this.close();
      throw error;
    } finally { owned.fill(0); this.busy = false; }
  }
  /** Encrypt a final short segment without padding, then close. Empty flush returns
   * null. It is never permissible to resume this stream afterward. */
  async flush(signal?: AbortSignal): Promise<EncryptedLivePcmSegment | null> {
    this.assertReady(); notAborted(signal); this.busy = true;
    const frames = this.bufferedFrames, start = this.segmentStartFrame;
    const owned = this.buffer.slice(0, frames * this.channels);
    try {
      return frames ? await this.encrypt(owned, frames, start, signal) : null;
    } finally { owned.fill(0); this.close(); this.busy = false; }
  }
  close(): void {
    this.closed = true; this.buffer.fill(0); this.bufferedFrames = 0;
  }
}
