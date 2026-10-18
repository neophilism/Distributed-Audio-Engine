import { invariant, integer } from './validation.mjs';
import { queueEncryptedLiveSegment } from './live-publish.mjs';

function wipe(segment) {
  segment.privateManifest.attachmentKeyHex = '';
  for (const bytes of segment.ciphertextChunks) bytes.fill(0);
}
function authorized(value, atMs) {
  invariant(value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype &&
    Reflect.ownKeys(value).every(key => typeof key === 'string') &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(d => 'value' in d && d.enumerable) &&
    Object.keys(value).sort().join(',') ===
    'allowed,authorizationValidUntilMs,expiresAtMs', 'LIVE_PUBLISH_RIGHTS_RESPONSE');
  invariant(value.allowed === true, 'LIVE_PUBLISH_RIGHTS_DENIED');
  integer(value.authorizationValidUntilMs, atMs + 1, atMs + 300000);
  integer(value.expiresAtMs, value.authorizationValidUntilMs, atMs + 300000);
  return value;
}

/** Application-driven, foreground-only live capture publishing. This does not
 * open a mic, establish root trust, create timers, or deliver a live program.
 * One push/flush holds the publishing lane, so ciphertext chunks and E2EE
 * manifests are queued in input order. Permissions are freshly checked at
 * each segment and no implicit rejoin follows any failure. */
export class EndpointLivePublisher {
  #segmenter; #channel; #relay; #recipient; #clock; #authorize;
  #abort = new AbortController(); #closed = false; #busy = false; #published = 0;
  constructor({ segmenter, channel, relay, recipient, nowUnixMs, authorizePublication }) {
    invariant(segmenter && typeof segmenter.push === 'function' &&
      typeof segmenter.flush === 'function' && typeof segmenter.close === 'function' &&
      channel && typeof channel.queueMessage === 'function' &&
      relay && typeof relay.uploadChunk === 'function' &&
      typeof nowUnixMs === 'function' && typeof authorizePublication === 'function',
      'LIVE_PUBLISHER_CONFIGURATION');
    this.#segmenter = segmenter; this.#channel = channel; this.#relay = relay;
    this.#recipient = recipient; this.#clock = nowUnixMs; this.#authorize = authorizePublication;
  }
  snapshot() {
    return { closed: this.#closed, busy: this.#busy, published: this.#published };
  }
  #open() {
    invariant(!this.#closed && !this.#busy && !this.#abort.signal.aborted,
      'LIVE_PUBLISHER_CLOSED_OR_BUSY');
  }
  async #run(sourceSignal, operation) {
    this.#open();
    invariant(sourceSignal === undefined || sourceSignal instanceof AbortSignal,
      'LIVE_PUBLISHER_SIGNAL');
    const abort = () => this.#abort.abort();
    sourceSignal?.addEventListener('abort', abort, { once: true });
    this.#busy = true;
    let segments = [];
    try {
      invariant(!sourceSignal?.aborted, 'LIVE_PUBLISH_ABORTED');
      segments = await operation(this.#abort.signal);
      invariant(!this.#closed && !this.#abort.signal.aborted, 'LIVE_PUBLISHER_CLOSED');
      const issued = [];
      for (const segment of segments) {
        try {
          invariant(!this.#closed && !this.#abort.signal.aborted, 'LIVE_PUBLISHER_CLOSED');
          const before = this.#clock(); integer(before);
          const policy = authorized(await this.#authorize(segment.segmentIndex, before, this.#abort.signal), this.#clock());
          invariant(!this.#closed && !this.#abort.signal.aborted, 'LIVE_PUBLISHER_CLOSED');
          const receipt = await queueEncryptedLiveSegment({
            channel: this.#channel, relay: this.#relay, recipient: this.#recipient,
            segment, nowUnixMs: this.#clock,
            authorizationValidUntilMs: policy.authorizationValidUntilMs,
            expiresAtMs: policy.expiresAtMs,
            signal: this.#abort.signal,
          });
          invariant(!this.#closed && !this.#abort.signal.aborted, 'LIVE_PUBLISHER_CLOSED');
          this.#published += 1;
          issued.push({ assetId: receipt.assetId, segmentIndex: receipt.segmentIndex,
            uploadedChunks: receipt.uploadedChunks, deliveryId: receipt.delivery.packet.deliveryId });
        } finally { wipe(segment); }
      }
      return issued;
    } catch (error) {
      // Cannot undo already-saved ciphertext or E2EE outbox records. No new
      // input may follow an uncertain partial commit; the app reconciles.
      this.close();
      throw error;
    } finally {
      for (const segment of segments) wipe(segment);
      sourceSignal?.removeEventListener('abort', abort);
      this.#busy = false;
    }
  }
  /** Frame cursor is exact bigint. Caller provides authorized, format-matched PCM. */
  push(frameStart, samples, signal) {
    return this.#run(signal, active => this.#segmenter.push(frameStart, samples, active));
  }
  /** Encrypt, upload and queue the last partial segment; then close forever. */
  async flush(signal) {
    try {
      return await this.#run(signal, async active => {
        const last = await this.#segmenter.flush(active);
        return last ? [last] : [];
      });
    } finally { this.close(); }
  }
  /** Cannot recall a previously committed relay object or queued Signal record.
   * Caller must also revoke memberships/rights and stop any receiver sessions. */
  close() {
    if (this.#closed) return;
    this.#closed = true; this.#abort.abort(); this.#segmenter.close();
  }
}
