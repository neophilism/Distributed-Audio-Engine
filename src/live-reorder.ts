import type { LiveSegmentContinuityOptions, LiveSegmentNotice } from './live-continuity.js';
import { LiveSegmentContinuity, validateLiveSegmentNotice } from './live-continuity.js';
import { integer, invariant } from './validation.js';

export interface LiveNoticeReorderOptions extends LiveSegmentContinuityOptions {
  /** Future segment notices held in a bounded application-owned memory window. */
  maxBufferedNotices?: number;
}

/** Strictly bounded notice-only reorder queue. The *caller* must authenticate
 * each parent E2EE notice, manifest, decrypted media and rights BEFORE offer.
 * No plaintext, manifest key, network call, retransmission, audio timer or
 * authorization decision is contained in this buffer. */
export class BoundedLiveNoticeReorder {
  private readonly continuity: LiveSegmentContinuity;
  private readonly expectedCapture: string;
  private readonly expectedRate: number;
  private readonly expectedChannels: number;
  private readonly limit: number;
  private readonly pending = new Map<number, LiveSegmentNotice>();
  private closed = false;

  constructor(options: LiveNoticeReorderOptions) {
    this.continuity = new LiveSegmentContinuity(options);
    this.expectedCapture = options.captureId;
    this.expectedRate = options.sampleRate;
    this.expectedChannels = options.channels;
    this.limit = options.maxBufferedNotices ?? 8;
    integer(this.limit, 1, 64);
  }

  snapshot() {
    const current = this.continuity.snapshot();
    return { closed: this.closed, nextIndex: current.nextIndex, nextFrame: current.nextFrame,
      bufferedIndices: [...this.pending.keys()].sort((a, b) => a - b) };
  }

  /** Release only exactly contiguous notices; out-of-order notices remain
   * bounded. Missing frames or changed formats never cause synthetic silence,
   * a hidden seek or an automatic clock correction. */
  offer(source: LiveSegmentNotice): LiveSegmentNotice[] {
    invariant(!this.closed, 'LIVE_REORDER_CLOSED');
    const start = validateLiveSegmentNotice(source);
    invariant(source.captureId === this.expectedCapture, 'LIVE_REORDER_CAPTURE_MISMATCH');
    invariant(source.sampleRate === this.expectedRate && source.channels === this.expectedChannels,
      'LIVE_REORDER_FORMAT_MISMATCH');
    const current = this.continuity.snapshot();
    integer(source.segmentIndex, current.nextIndex, current.nextIndex + this.limit);
    invariant(!this.pending.has(source.segmentIndex), 'LIVE_REORDER_DUPLICATE_PENDING');

    // Every field was validated as a plain enumerable value, so this copy
    // cannot retain an accessor or a caller-mutated future notice object.
    const copy: LiveSegmentNotice = { captureId: source.captureId,
      parentMessageId: source.parentMessageId, segmentIndex: source.segmentIndex,
      startFrameDecimal: start.toString(10), frames: source.frames,
      sampleRate: source.sampleRate, channels: source.channels };
    const proposed = new Map(this.pending);
    proposed.set(copy.segmentIndex, copy);

    // Preflight ALL immediately releasable notices before mutating the
    // continuity cursor. One malformed ahead-of-time segment cannot partially
    // advance playback when an earlier gap finally arrives.
    const ready: LiveSegmentNotice[] = [];
    let frame = current.nextFrame, index = current.nextIndex;
    while (proposed.has(index)) {
      const notice = proposed.get(index)!;
      const nextStart = validateLiveSegmentNotice(notice);
      invariant(nextStart === frame, 'LIVE_REORDER_FRAME_DISCONTINUITY');
      frame += BigInt(notice.frames); index++;
      ready.push(notice);
    }
    invariant(proposed.size - ready.length <= this.limit, 'LIVE_REORDER_CAPACITY_EXCEEDED');
    for (const notice of ready) {
      this.continuity.accept(notice);
      proposed.delete(notice.segmentIndex);
    }
    this.pending.clear();
    for (const [key, value] of proposed) this.pending.set(key, value);
    return ready.map(notice => Object.freeze({ ...notice }));
  }

  /** Closes on session revocation or an unrecoverable missing segment.
   * The caller also closes the signed playback authority and native sink. */
  close(): void {
    this.closed = true;
    this.pending.clear();
    this.continuity.close();
  }
}
