import { ControlVerifier, signControl, EndpointAttachmentReader } from '../../../dist/src/index.js';
import { EncryptedCheckpointStore } from './vault.mjs';
import { ManifestHeads } from './manifest-heads.mjs';
import { snapshot, exact, bytes64, jsonBytes, canonicalJson, parseCanonicalJson, integer, identifier,
  invariant, digest, MAX_WIRE_BYTES } from './validation.mjs';

/** Membership is rechecked even for emergency-stop commands, whose payload is
 * intentionally not decoded by PlaybackAuthority. A pinned old signer alone
 * must not retain command authority after root-verified rotation/revocation.
 */
class MembershipControlVerifier extends ControlVerifier {
  constructor(scope, signers, checkpoints, channel, sender, actions = new Set(['lease', 'emergency-stop'])) {
    super(scope, signers, actions, checkpoints);
    this.channel = channel; this.sender = sender;
  }
  async accept(control, nowMs) {
    const before = this.channel.requirePeer(this.sender, 'control');
    const body = await super.accept(control, nowMs);
    const after = this.channel.requirePeer(this.sender, 'control');
    invariant(canonicalJson(before) === canonicalJson(after) && body.keyId === after.device.signing.id,
      'PARENT_CONTROL_MEMBERSHIP_CHANGED');
    return body;
  }
}
function header(body) { const { payloadCiphertextBase64: _ciphertext, ...value } = body; return value; }

/** Encrypt the private control with the real ratchet, then bind its ciphertext
 * to the existing independently verified DAE signed-control header.
 */
export async function createSignalControl(channel, recipient, fields, payload) {
  exact(fields, ['epoch', 'sequence', 'issuedAtMs', 'expiresAtMs', 'action']);
  invariant(['lease', 'emergency-stop'].includes(fields.action), 'PARENT_UNSUPPORTED_CONTROL');
  const own = channel.publicIdentity, peer = channel.requirePeer(recipient, 'control', 'send');
  const body = { version: '1.0.0', scope: own.scope, keyId: own.device.signing.id, algorithm: 'ALG-ED25519', ...snapshot(fields) };
  const wire = await channel.seal(recipient, 'control', { header: body, value: snapshot(payload) },
    { messageId: crypto.randomUUID(), expiresAtMs: fields.expiresAtMs });
  const encoded = jsonBytes(wire); invariant(encoded.length <= MAX_WIRE_BYTES, 'PARENT_CONTROL_TOO_LARGE');
  const result = await signControl({ ...body, payloadCiphertextBase64: encoded.toString('base64') }, await channel.localControlKey());
  invariant(canonicalJson(channel.requirePeer(recipient, 'control', 'send')) === canonicalJson(peer), 'PARENT_CONTROL_MEMBERSHIP_CHANGED');
  return result;
}

/** Private-manifest inbox at the listening endpoint. Optional durable mode
 * rehydrates authenticated journal entries but never restarts audio. Ciphertext travels
 * over the caller's transport; keys only enter this inbox after Signal decrypts
 * and its ratchet state commits. No service manifest or static-key fallback.
 */
export class SignalPlaybackInbox {
  #channel; #sender; #scope; #now; #durable; #heads; #assets = new Map(); #closed = false;
  constructor({ channel, sender, nowUnixMs, durable = false, vault }) {
    invariant(typeof durable === 'boolean', 'PARENT_INVALID_DURABLE_MODE'); this.#durable = durable;
    this.#channel = channel; this.#sender = sender; this.#scope = channel.publicIdentity.scope; this.#now = nowUnixMs;
    channel.requirePeer(sender, 'manifest'); channel.requirePeer(sender, 'control');
    if (durable) this.#heads = new ManifestHeads(vault, { scope: this.#scope, sender, receiver: channel.publicIdentity.address });
  }
  async createVerifier(vault) {
    const record = this.#channel.requirePeer(this.#sender, 'control');
    const key = await this.#channel.controlPublicKey(this.#sender);
    this.#channel.requirePeer(this.#sender, 'control');
    return new MembershipControlVerifier(this.#scope, new Map([[record.device.signing.id, key]]),
      new EncryptedCheckpointStore(vault), this.#channel, this.#sender);
  }
  /** Shares the same durable strict-sequence checkpoint as playback controls.
   * Deliver clock and playback controls in order; a gap requires a fresh epoch. */
  async createClockVerifier(vault) {
    this.#open();
    const record = this.#channel.requirePeer(this.#sender, 'control');
    const key = await this.#channel.controlPublicKey(this.#sender);
    this.#open(); this.#channel.requirePeer(this.#sender, 'control');
    return new MembershipControlVerifier(this.#scope, new Map([[record.device.signing.id, key]]),
      new EncryptedCheckpointStore(vault), this.#channel, this.#sender, new Set(['clock-response']));
  }
  async sessionOptions({ vault, timeline, transport, authorizePlayback, consentedGainCeiling }) {
    this.#open(); invariant(typeof authorizePlayback === 'function', 'PARENT_RIGHTS_ADAPTER_REQUIRED');
    const controls = await this.createVerifier(vault);
    return { scope: snapshot(this.#scope), timeline, transport, controls, consentedGainCeiling,
      nowUnixMs: this.#now, resolver: this.resolver, decodeControlPayload: this.decodeControlPayload,
      authorizePlayback: async (assetId, atMs, signal) => {
        this.#open(); this.#channel.requirePeer(this.#sender, 'manifest');
        const before = this.#channel.requirePeer(this.#sender, 'control');
        const permission = await authorizePlayback(assetId, atMs, signal);
        this.#open(); invariant(!signal.aborted, 'PARENT_PLAYBACK_CANCELLED');
        this.#channel.requirePeer(this.#sender, 'manifest');
        const after = this.#channel.requirePeer(this.#sender, 'control');
        invariant(canonicalJson(before) === canonicalJson(after), 'PARENT_PLAYBACK_MEMBERSHIP_CHANGED');
        if (permission?.allowed === false) return { allowed: false };
        exact(permission, ['allowed', 'validUntilMs']); invariant(permission.allowed === true, 'PARENT_PLAYBACK_DENIED');
        integer(permission.validUntilMs, this.#now() + 1);
        return { allowed: true, validUntilMs: Math.min(permission.validUntilMs, after.expiresAtMs) };
      }
    };
  }
  #open() { invariant(!this.#closed, 'PARENT_INBOX_CLOSED'); }
  #clear(entry) { entry.descriptor.manifest.attachmentKeyHex = ''; }
  async acceptManifest(wire) {
    this.#open(); invariant(wire.from === this.#sender, 'PARENT_MANIFEST_SENDER_MISMATCH');
    const message = this.#durable
      ? (await this.#channel.receiveQueued(wire, 'manifest')).message
      : await this.#channel.receive(wire, 'manifest');
    this.#open(); invariant(message, 'PARENT_MANIFEST_COMPLETED');
    return this.#install(message, await this.#descriptor(message));
  }
  async #descriptor(message) {
    const descriptor = snapshot(message.payload);
    exact(descriptor, ['assetId', 'context', 'manifest', 'sampleRate', 'channels', 'frames', 'authorizationValidUntilMs']);
    exact(descriptor.context, ['tenantId', 'application', 'parentMessageId']);
    identifier(descriptor.assetId); identifier(descriptor.context.parentMessageId);
    invariant(descriptor.context.tenantId === this.#scope.tenantId && descriptor.context.application === this.#scope.application &&
      descriptor.context.parentMessageId === message.messageId, 'PARENT_MANIFEST_BINDING_MISMATCH');
    const now = this.#now(); integer(now); integer(descriptor.sampleRate, 8000, 192000);
    integer(descriptor.channels, 1, 8); integer(descriptor.frames, 1);
    integer(descriptor.authorizationValidUntilMs, 1, message.issuedAtMs + 300_000);
    invariant(descriptor.manifest.mediaType === 'audio/wav', 'PARENT_UNSUPPORTED_MEDIA');
    descriptor.authorizationValidUntilMs = Math.min(descriptor.authorizationValidUntilMs, message.expiresAtMs);
    const reader = await EndpointAttachmentReader.open(descriptor.manifest, descriptor.context); reader.close();
    this.#open(); this.#channel.requirePeer(this.#sender, 'manifest');
    return descriptor;
  }
  #install(message, descriptor) {
    this.#open(); this.#channel.requirePeer(this.#sender, 'manifest');
    invariant(descriptor.authorizationValidUntilMs > this.#now(), 'PARENT_MANIFEST_EXPIRED');
    for (const [id, entry] of this.#assets) if (entry.descriptor.authorizationValidUntilMs <= this.#now()) {
      this.#clear(entry); this.#assets.delete(id);
    }
    const previous = this.#assets.get(descriptor.assetId);
    const fingerprint = digest(message);
    if (this.#durable && previous?.fingerprint === fingerprint) {
      this.#heads.remember(message, this.#now()); this.#clear({ descriptor });
      return { assetId: descriptor.assetId, expiresAtMs: previous.descriptor.authorizationValidUntilMs };
    }
    invariant(!previous || message.issuedAtMs > previous.issuedAtMs, 'PARENT_MANIFEST_ROLLBACK');
    invariant(previous || this.#assets.size < 8, 'PARENT_MANIFEST_LIMIT');
    this.#heads?.remember(message, this.#now());
    if (previous) this.#clear(previous);
    this.#assets.set(descriptor.assetId, { descriptor, issuedAtMs: message.issuedAtMs, fingerprint });
    return { assetId: descriptor.assetId, expiresAtMs: descriptor.authorizationValidUntilMs };
  }
  /** Call explicitly before a fresh playback join. All pending manifests are
   * revalidated; only the newest unexpired descriptor per asset is installed.
   * Invalid or ambiguous recovery clears volatile keys and never starts output.
   */
  async restoreManifests() {
    this.#open(); invariant(this.#durable, 'PARENT_DURABLE_MODE_REQUIRED');
    const selected = new Map();
    try {
      const pending = await this.#channel.pendingMessages(this.#sender);
      this.#open();
      for (const entry of pending) {
        if (entry.kind !== 'manifest') continue;
        const descriptor = await this.#descriptor(entry.message);
        const previous = selected.get(descriptor.assetId);
        invariant(!previous || previous.message.issuedAtMs !== entry.message.issuedAtMs,
          'PARENT_MANIFEST_AMBIGUOUS_RECOVERY');
        if (!previous || previous.message.issuedAtMs < entry.message.issuedAtMs) {
          if (previous) this.#clear(previous);
          selected.set(descriptor.assetId, { message: entry.message, descriptor });
        } else this.#clear({ descriptor });
      }
      invariant(selected.size <= 8, 'PARENT_MANIFEST_LIMIT');
      for (const entry of this.#assets.values()) this.#clear(entry); this.#assets.clear();
      const restored = [];
      for (const entry of selected.values()) {
        this.#heads.remember(entry.message, this.#now());
        if (entry.descriptor.authorizationValidUntilMs <= this.#now()) this.#clear(entry);
        else restored.push(this.#install(entry.message, entry.descriptor));
      }
      return restored;
    } catch (error) {
      for (const entry of selected.values()) this.#clear(entry);
      for (const entry of this.#assets.values()) this.#clear(entry); this.#assets.clear(); throw error;
    }
  }
  resolver = {
    resolve: async (assetId, scope, signal) => {
      this.#open(); identifier(assetId);
      invariant(!signal.aborted && canonicalJson(scope) === canonicalJson(this.#scope), 'PARENT_RESOLVER_SCOPE_OR_CANCELLED');
      const peer = this.#channel.requirePeer(this.#sender, 'manifest');
      const entry = this.#assets.get(assetId); invariant(entry, 'PARENT_MANIFEST_UNAVAILABLE');
      const now = this.#now(); integer(now);
      if (entry.descriptor.authorizationValidUntilMs <= now) {
        this.#clear(entry); this.#assets.delete(assetId); throw new Error('PARENT_MANIFEST_EXPIRED');
      }
      const result = snapshot(entry.descriptor);
      result.authorizationValidUntilMs = Math.min(result.authorizationValidUntilMs, peer.expiresAtMs);
      return result;
    }
  };
  decodeControlPayload = async body => {
    this.#open();
    invariant(canonicalJson(body.scope) === canonicalJson(this.#scope), 'PARENT_CONTROL_SCOPE_MISMATCH');
    const bytes = bytes64(body.payloadCiphertextBase64, MAX_WIRE_BYTES);
    const wire = parseCanonicalJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    invariant(wire.from === this.#sender, 'PARENT_CONTROL_SENDER_MISMATCH');
    const envelope = this.#durable
      ? (await this.#channel.receiveQueued(wire, 'control')).message
      : await this.#channel.receive(wire, 'control');
    this.#open(); invariant(envelope, 'PARENT_CONTROL_COMPLETED');
    exact(envelope.payload, ['header', 'value']);
    invariant(canonicalJson(envelope.payload.header) === canonicalJson(header(body)) &&
      envelope.expiresAtMs === body.expiresAtMs, 'PARENT_CONTROL_HEADER_MISMATCH');
    return snapshot(envelope.payload.value);
  };
  close() {
    this.#closed = true; for (const entry of this.#assets.values()) this.#clear(entry); this.#assets.clear();
  }
}
