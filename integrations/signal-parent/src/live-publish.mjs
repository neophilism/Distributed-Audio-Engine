import { EndpointAttachmentReader } from '../../../dist/src/index.js';
import { canonicalJson, exact, integer, invariant, snapshot } from './validation.mjs';

const address = value => invariant(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value),
  'LIVE_PUBLISH_RECIPIENT');
const notAborted = signal => invariant(!signal?.aborted, 'LIVE_PUBLISH_ABORTED');

/** Push independently AEAD-authenticated ciphertext to the existing TLS relay,
 * THEN enqueue its PRIVATE descriptor on the actual E2EE Signal parent channel.
 * No relay-held keys, plaintext content, manifest metadata, auto-retry, or
 * automatic background network activity. The app owns explicit flush/rights. */
export async function queueEncryptedLiveSegment({
  channel, relay, recipient, segment, authorizationValidUntilMs, expiresAtMs, nowUnixMs, signal,
}) {
  invariant(channel && typeof channel.queueMessage === 'function' &&
    typeof channel.requirePeer === 'function' && relay &&
    typeof relay.uploadChunk === 'function' && typeof nowUnixMs === 'function',
    'LIVE_PUBLISH_CONFIGURATION');
  invariant(signal === undefined || signal instanceof AbortSignal, 'LIVE_PUBLISH_SIGNAL');
  address(recipient); notAborted(signal);
  const now = nowUnixMs(); integer(now); integer(expiresAtMs, now + 1, now + 300000);
  integer(authorizationValidUntilMs, now + 1, expiresAtMs);
  const own = snapshot(channel.publicIdentity);
  const peer = snapshot(channel.requirePeer(recipient, 'manifest', 'send'));
  invariant(peer.expiresAtMs >= expiresAtMs, 'LIVE_PUBLISH_MEMBERSHIP_EXPIRY');

  invariant(segment && typeof segment === 'object' && segment.privateManifest &&
    segment.privateMetadata && Array.isArray(segment.ciphertextChunks),
    'LIVE_PUBLISH_SEGMENT');
  const manifest = snapshot(segment.privateManifest);
  const meta = snapshot(segment.privateMetadata);
  const scope = own.scope;
  invariant(manifest.tenantId === scope.tenantId &&
    manifest.application === scope.application &&
    meta.frames === segment.frames && meta.sampleRate === segment.privateMetadata.sampleRate &&
    meta.channels === segment.privateMetadata.channels, 'LIVE_PUBLISH_SCOPE_OR_GEOMETRY');
  integer(segment.segmentIndex, 0, 999999); integer(segment.frames, 1);
  integer(meta.sampleRate, 8000, 192000); integer(meta.channels, 1, 8);
  invariant(typeof manifest.parentMessageId === 'string' &&
    manifest.parentMessageId.endsWith('-' + segment.segmentIndex) &&
    manifest.chunkCount === segment.ciphertextChunks.length &&
    manifest.chunkCount >= 1 && manifest.chunkCount <= 64, 'LIVE_PUBLISH_CHUNK_GEOMETRY');
  const context = { tenantId: scope.tenantId,
    application: scope.application, parentMessageId: manifest.parentMessageId };
  const descriptor = { assetId: manifest.parentMessageId, context, manifest,
    sampleRate: meta.sampleRate, channels: meta.channels, frames: meta.frames,
    authorizationValidUntilMs };
  const reader = await EndpointAttachmentReader.open(manifest, context);
  let uploaded = 0;
  try {
    for (let index = 0; index < manifest.chunkCount; index++) {
      notAborted(signal);
      invariant(canonicalJson(channel.publicIdentity) === canonicalJson(own) &&
        canonicalJson(channel.requirePeer(recipient, 'manifest', 'send')) === canonicalJson(peer),
        'LIVE_PUBLISH_MEMBERSHIP_CHANGED');
      const source = segment.ciphertextChunks[index];
      invariant(source instanceof Uint8Array &&
        source.byteLength === reader.ciphertextLength(index), 'LIVE_PUBLISH_CHUNK_LENGTH');
      // Own one ciphertext chunk throughout async authentication and upload.
      // Mutations to the application-supplied buffer cannot change the bytes
      // actually submitted after successful tag authentication.
      const bytes = Uint8Array.from(source);
      try {
        const plaintext = await reader.decryptChunk(index, bytes);
        plaintext.fill(0);
        notAborted(signal);
        const receipt = await relay.uploadChunk({
          application: scope.application, tenantId: scope.tenantId,
          storageObjectId: manifest.storageObjectId, chunkIndex: index,
          ciphertextBase64: Buffer.from(bytes).toString('base64'),
          readers: [recipient], expiresAtMs,
        }, signal);
        exact(receipt, ['chunkId', 'status']);
        invariant(typeof receipt.chunkId === 'string' && /^[0-9a-f]{64}$/.test(receipt.chunkId) &&
          receipt.status === 'stored', 'LIVE_PUBLISH_RECEIPT');
        notAborted(signal); uploaded++;
      } finally { bytes.fill(0); }
    }
  } finally { reader.close(); }

  invariant(canonicalJson(channel.publicIdentity) === canonicalJson(own) &&
    canonicalJson(channel.requirePeer(recipient, 'manifest', 'send')) === canonicalJson(peer),
    'LIVE_PUBLISH_MEMBERSHIP_CHANGED');
  notAborted(signal);
  // The receiver's manifest inbox binds context.parentMessageId to this exact
  // Signal message ID, and protects the descriptor in endpoint-only ciphertext.
  const delivery = await channel.queueMessage(recipient, 'manifest', descriptor,
    { messageId: manifest.parentMessageId, expiresAtMs });
  notAborted(signal);
  invariant(delivery?.recipient === recipient && delivery.kind === 'manifest' &&
    delivery.packet?.recordType === 'signal' &&
    delivery.packet.deliveryId === manifest.parentMessageId,
    'LIVE_PUBLISH_MESSAGE_MISMATCH');
  return { assetId: manifest.parentMessageId, segmentIndex: segment.segmentIndex,
    uploadedChunks: uploaded, delivery };
}
