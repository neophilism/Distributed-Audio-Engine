import type { Scope } from './contracts.js';
import type { EncryptedLivePcmSegment } from './live-input.js';
import { validateManifest } from './attachments.js';
import { describeLiveSegment, LiveSegmentContinuity } from './live-continuity.js';
import type { LiveSegmentNotice } from './live-continuity.js';
import { identifier, integer, invariant } from './validation.js';

export interface LiveCiphertextUpload {
  tenantId: string;
  application: Scope['application'];
  storageObjectId: string;
  chunkIndex: number;
  ciphertext: Uint8Array;
  readers: readonly string[];
  expiresAtMs: number;
}
export interface LivePrivateDelivery {
  notice: LiveSegmentNotice;
  privateManifest: EncryptedLivePcmSegment['privateManifest'];
  privateMetadata: EncryptedLivePcmSegment['privateMetadata'];
}
export interface LivePublisherOptions {
  scope: Scope;
  /** Bound by the authenticated parent identity, including the capture incarnation. */
  captureId: string;
  sampleRate: number;
  channels: number;
  initialFrame?: bigint;
  readers: readonly string[];
  expiresAtMs: number;
  nowMs: () => number;
  /** A ciphertext-only relay adapter. It must acknowledge durable storage. */
  upload: (request: Readonly<LiveCiphertextUpload>, signal?: AbortSignal) => Promise<void>;
  /** An authenticated E2EE parent adapter. It must acknowledge durable delivery. */
  deliverPrivate: (delivery: Readonly<LivePrivateDelivery>, signal?: AbortSignal) => Promise<void>;
}

/** Strict one-at-a-time endpoint publisher. Unknown effects are reconciled by
 * the application; this class never re-encrypts or automatically retries them. */
export class LiveSegmentPublisher {
  private readonly continuity: LiveSegmentContinuity;
  private readonly readers: readonly string[];
  private closed = false;
  private busy = false;
  constructor(private readonly options: LivePublisherOptions) {
    invariant(options && typeof options === 'object', 'LIVE_PUBLISH_OPTIONS');
    identifier(options.scope.tenantId); identifier(options.scope.sessionId);
    invariant(options.scope.application === 'scenesignal' || options.scope.application === 'distributed-radio',
      'LIVE_PUBLISH_SCOPE');
    invariant(Array.isArray(options.readers) && options.readers.length >= 1 &&
      options.readers.length <= 32 && new Set(options.readers).size === options.readers.length,
      'LIVE_PUBLISH_READERS');
    options.readers.forEach(identifier);
    integer(options.expiresAtMs, 1);
    invariant(typeof options.nowMs === 'function' && typeof options.upload === 'function' &&
      typeof options.deliverPrivate === 'function', 'LIVE_PUBLISH_ADAPTERS');
    this.readers = Object.freeze([...options.readers]);
    this.continuity = new LiveSegmentContinuity({
      captureId: options.captureId, sampleRate: options.sampleRate,
      channels: options.channels, initialFrame: options.initialFrame
    });
  }
  snapshot() { return { closed: this.closed, busy: this.busy, ...this.continuity.snapshot() }; }
  close(): void { this.closed = true; this.continuity.close(); }
  async publish(segment: Readonly<EncryptedLivePcmSegment>, signal?: AbortSignal): Promise<LiveSegmentNotice> {
    invariant(!this.closed && !this.busy, 'LIVE_PUBLISH_CLOSED_OR_BUSY');
    invariant(signal === undefined || signal instanceof AbortSignal, 'LIVE_PUBLISH_SIGNAL');
    invariant(!signal?.aborted, 'LIVE_PUBLISH_ABORTED');
    this.busy = true;
    try {
      const notice = describeLiveSegment(segment);
      const manifest = segment.privateManifest;
      invariant(manifest.tenantId === this.options.scope.tenantId &&
        manifest.application === this.options.scope.application, 'LIVE_PUBLISH_SCOPE_MISMATCH');
      await validateManifest(manifest, {
        tenantId: this.options.scope.tenantId,
        application: this.options.scope.application,
        parentMessageId: notice.parentMessageId
      });
      invariant(Array.isArray(segment.ciphertextChunks) &&
        segment.ciphertextChunks.length === manifest.chunkCount &&
        segment.ciphertextChunks.length <= 64, 'LIVE_PUBLISH_CHUNK_COUNT');
      const now = this.options.nowMs(); integer(now, 0);
      invariant(this.options.expiresAtMs > now && this.options.expiresAtMs <= now + 86400000,
        'LIVE_PUBLISH_EXPIRED');
      this.continuity.accept(notice);
      for (let index = 0; index < segment.ciphertextChunks.length; index++) {
        invariant(!signal?.aborted, 'LIVE_PUBLISH_ABORTED');
        const chunk = segment.ciphertextChunks[index]!;
        const expected = Math.min(manifest.chunkSizeBytes,
          manifest.plaintextSizeBytes - index * manifest.chunkSizeBytes) + 16;
        invariant(chunk instanceof Uint8Array && chunk.buffer instanceof ArrayBuffer &&
          chunk.byteLength === expected, 'LIVE_PUBLISH_CHUNK_INVALID');
        const copy = Uint8Array.from(chunk);
        try {
          await this.options.upload(Object.freeze({
            tenantId: this.options.scope.tenantId, application: this.options.scope.application,
            storageObjectId: manifest.storageObjectId, chunkIndex: index,
            ciphertext: copy, readers: this.readers, expiresAtMs: this.options.expiresAtMs
          }), signal);
        } finally { copy.fill(0); }
      }
      invariant(!signal?.aborted, 'LIVE_PUBLISH_ABORTED');
      await this.options.deliverPrivate(Object.freeze({
        notice, privateManifest: structuredClone(manifest),
        privateMetadata: structuredClone(segment.privateMetadata)
      }), signal);
      invariant(!signal?.aborted, 'LIVE_PUBLISH_ABORTED');
      return notice;
    } catch (error) {
      this.close();
      throw error;
    } finally { this.busy = false; }
  }
}
