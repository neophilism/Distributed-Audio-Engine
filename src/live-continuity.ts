import type { EncryptedLivePcmSegment } from './live-input.js';
import { identifier, integer, invariant } from './validation.js';

const MAX_SAMPLE_BYTES = 2 * 1024 * 1024;
const MAX_SEGMENTS = 1_000_000;
const MAX_FRAME = (1n << 64n) - 1n;

/** Canonical JSON-safe position metadata for a single already-authorized,
 * endpoint-encrypted live PCM segment. The parent must authenticate this
 * metadata alongside the private manifest; this object is NOT an authority. */
export interface LiveSegmentNotice {
  captureId: string;
  parentMessageId: string;
  segmentIndex: number;
  startFrameDecimal: string;
  frames: number;
  sampleRate: number;
  channels: number;
}

function parseFrame(value: string): bigint {
  invariant(typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value), 'LIVE_NOTICE_NONCANONICAL_FRAME');
  const frame = BigInt(value);
  invariant(frame <= MAX_FRAME, 'LIVE_NOTICE_FRAME_OVERFLOW');
  return frame;
}

export function validateLiveSegmentNotice(value: LiveSegmentNotice): bigint {
  invariant(value && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).every(key => typeof key === 'string') &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(d => 'value' in d && d.enumerable) &&
    Object.keys(value).sort().join(',') ===
      'captureId,channels,frames,parentMessageId,sampleRate,segmentIndex,startFrameDecimal',
    'LIVE_NOTICE_FIELDS');
  identifier(value.captureId); identifier(value.parentMessageId);
  invariant(value.captureId.length <= 120, 'LIVE_NOTICE_CAPTURE_ID_LIMIT');
  integer(value.segmentIndex, 0, MAX_SEGMENTS - 1);
  integer(value.sampleRate, 8000, 192000);
  integer(value.channels, 1, 8);
  integer(value.frames, 1, value.sampleRate);
  invariant(value.frames * value.channels * 4 <= MAX_SAMPLE_BYTES, 'LIVE_NOTICE_FRAME_LIMIT');
  invariant(value.parentMessageId === `${value.captureId}-${value.segmentIndex}`, 'LIVE_NOTICE_ID_MISMATCH');
  const frame = parseFrame(value.startFrameDecimal);
  invariant(frame + BigInt(value.frames) <= MAX_FRAME, 'LIVE_NOTICE_FRAME_OVERFLOW');
  return frame;
}

/** Formats already-encrypted publisher output for authenticated parent delivery.
 * It intentionally never includes key material, plaintext, ciphertext or a
 * relay object URI. The caller sends it with the private manifest via E2EE. */
export function describeLiveSegment(segment: Readonly<EncryptedLivePcmSegment>): LiveSegmentNotice {
  invariant(segment && segment.privateManifest && segment.privateMetadata, 'LIVE_NOTICE_SEGMENT');
  const parentMessageId = segment.privateManifest.parentMessageId;
  integer(segment.segmentIndex, 0, MAX_SEGMENTS - 1);
  const suffix = `-${segment.segmentIndex}`;
  invariant(typeof parentMessageId === 'string' && parentMessageId.endsWith(suffix), 'LIVE_NOTICE_PARENT_ID');
  const captureId = parentMessageId.slice(0, -suffix.length);
  invariant(typeof segment.startFrame === 'bigint' && segment.startFrame >= 0n,
    'LIVE_NOTICE_SOURCE_FRAME');
  invariant(segment.frames === segment.privateMetadata.frames &&
    segment.privateMetadata.sampleRate >= 8000 && segment.privateMetadata.channels >= 1,
    'LIVE_NOTICE_SOURCE_GEOMETRY');
  const notice: LiveSegmentNotice = {
    captureId, parentMessageId, segmentIndex: segment.segmentIndex,
    startFrameDecimal: segment.startFrame.toString(10), frames: segment.frames,
    sampleRate: segment.privateMetadata.sampleRate,
    channels: segment.privateMetadata.channels,
  };
  validateLiveSegmentNotice(notice);
  return Object.freeze(notice);
}

export interface LiveSegmentContinuityOptions {
  /** Must be pinned by authenticated E2EE application identity, never relay JSON. */
  captureId: string;
  sampleRate: number;
  channels: number;
  initialFrame?: bigint;
}

/** A bounded strict-order *geometry* gate for received live segments.
 * Call only after E2EE-authenticated manifest/notice and decrypted media
 * metadata match. No jitter buffering, timing proof, rights check, AEAD or
 * durable replay checkpoint is supplied here. */
export class LiveSegmentContinuity {
  private readonly captureId: string;
  private readonly rate: number;
  private readonly channels: number;
  private nextIndex = 0;
  private nextFrame: bigint;
  private closed = false;
  constructor(options: LiveSegmentContinuityOptions) {
    invariant(options && typeof options === 'object', 'LIVE_CONTINUITY_OPTIONS');
    identifier(options.captureId);
    invariant(options.captureId.length <= 120, 'LIVE_NOTICE_CAPTURE_ID_LIMIT');
    integer(options.sampleRate, 8000, 192000);
    integer(options.channels, 1, 8);
    this.captureId = options.captureId;
    this.rate = options.sampleRate;
    this.channels = options.channels;
    this.nextFrame = options.initialFrame ?? 0n;
    invariant(typeof this.nextFrame === 'bigint' && this.nextFrame >= 0n &&
      this.nextFrame <= MAX_FRAME, 'LIVE_CONTINUITY_START_FRAME');
  }
  snapshot() {
    return { closed: this.closed, nextIndex: this.nextIndex, nextFrame: this.nextFrame };
  }
  accept(notice: LiveSegmentNotice): { segmentIndex: number; startFrame: bigint; nextFrame: bigint } {
    invariant(!this.closed, 'LIVE_CONTINUITY_CLOSED');
    const start = validateLiveSegmentNotice(notice);
    invariant(notice.captureId === this.captureId, 'LIVE_CONTINUITY_CAPTURE_MISMATCH');
    invariant(notice.sampleRate === this.rate && notice.channels === this.channels,
      'LIVE_CONTINUITY_FORMAT_MISMATCH');
    invariant(notice.segmentIndex === this.nextIndex, 'LIVE_CONTINUITY_INDEX_GAP_OR_REPLAY');
    invariant(start === this.nextFrame, 'LIVE_CONTINUITY_FRAME_GAP_OR_REPLAY');
    const nextFrame = start + BigInt(notice.frames);
    this.nextFrame = nextFrame;
    this.nextIndex += 1;
    return { segmentIndex: notice.segmentIndex, startFrame: start, nextFrame };
  }
  close(): void { this.closed = true; }
}
