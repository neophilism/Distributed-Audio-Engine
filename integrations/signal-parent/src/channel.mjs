import { randomInt } from 'node:crypto';
import * as signal from '@signalapp/libsignal-client';
import { DeviceRegistry, signControl, authenticateControl } from '../../../dist/src/index.js';
import { journalFor, checkJournal, findOutgoing, saveOutgoing, deliveryView, findIncoming,
  saveIncoming, incomingView, markSent, completeIncoming } from './journal.mjs';
import { PROTOCOL, MAX_MESSAGE_BYTES, MAX_WIRE_BYTES, MAX_LIFETIME_MS, jsonBytes,
  digest, snapshot, exact, bytes64, scopeCheck, addressFor, publicDescriptor,
  assertLifetime, canonicalJson, parseCanonicalJson, identifier, integer, invariant } from './validation.mjs';

const b64 = bytes => Buffer.from(bytes).toString('base64');
const hex = bytes => Buffer.from(bytes).toString('hex');
const KINDS = ['manifest', 'control', 'ack'];
const ROW = 'signal-state';
const ADDRESS_DEVICE = 1; // Generation and device identity are bound in the address digest.
async function signingKey(state) {
  const raw = bytes64(state.signingPrivate, 256);
  try { return await crypto.subtle.importKey('pkcs8', raw, 'Ed25519', false, ['sign']); }
  finally { raw.fill(0); }
}
async function verifyEd(publicHex, signature, bytes) {
  invariant(typeof publicHex === 'string' && /^[0-9a-f]{64}$/.test(publicHex), 'PARENT_INVALID_SIGNER');
  const key = await crypto.subtle.importKey('raw', Buffer.from(publicHex, 'hex'), 'Ed25519', false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, bytes64(signature, 64, 64), bytes);
}
function serializePrivate(record) {
  const bytes = record.serialize();
  try { return b64(bytes); } finally { bytes.fill(0); }
}
function activeDevice(registry, deviceId, scope) {
  invariant(registry instanceof DeviceRegistry, 'PARENT_VERIFIED_REGISTRY_REQUIRED');
  const view = registry.snapshot();
  invariant(view.scope.tenantId === scope.tenantId && view.scope.application === scope.application, 'PARENT_REGISTRY_SCOPE_MISMATCH');
  const device = view.devices.find(value => value.id === deviceId);
  invariant(device?.status === 'active', 'PARENT_DEVICE_REVOKED_OR_UNKNOWN');
  return { identityId: view.scope.identityId, device };
}
function noStatus(device) { const { status: _status, ...record } = device; return record; }

/** Explicit endpoint initialization, before account-root enrollment. Never called
 * automatically on a missing/corrupt store. Only the public descriptor is returned.
 */
export async function initializeSignalIdentity(vault, { scope, identityId, deviceId, generation = 1, nowMs }) {
  scopeCheck(scope); identifier(identityId); identifier(deviceId); integer(generation, 1); integer(nowMs);
  invariant(vault.read(ROW) === undefined, 'SIGNAL_IDENTITY_ALREADY_INITIALIZED');
  const agreement = signal.PrivateKey.generate(), signing = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const publicSigning = new Uint8Array(await crypto.subtle.exportKey('raw', signing.publicKey));
  const privateSigning = new Uint8Array(await crypto.subtle.exportKey('pkcs8', signing.privateKey));
  const keyPublic = agreement.getPublicKey(), keyBytes = keyPublic.getPublicKeyBytes();
  invariant(keyBytes.length === 32, 'SIGNAL_UNSUPPORTED_IDENTITY');
  const signed = signal.PrivateKey.generate();
  const signedRecord = signal.SignedPreKeyRecord.new(1, nowMs, signed.getPublicKey(), signed, agreement.sign(signed.getPublicKey().serialize()));
  const device = { id: deviceId, generation,
    signing: { id: 's-' + digest(hex(publicSigning)), algorithm: 'ALG-ED25519', publicKeyHex: hex(publicSigning) },
    agreement: { id: 'a-' + digest(hex(keyBytes)), algorithm: 'ALG-X25519', publicKeyHex: hex(keyBytes) } };
  const state = { version: 1, protocol: PROTOCOL, scope: snapshot(scope), identityId, device,
    address: addressFor(scope, identityId, deviceId, generation), registrationId: randomInt(1, 16384),
    identityPrivate: serializePrivate(agreement), signingPrivate: b64(privateSigning), signedPreKey: serializePrivate(signedRecord),
    nextPreKeyId: 0, preKeys: {}, kyberKeys: {}, sessions: {}, lastNowMs: nowMs };
  privateSigning.fill(0);
  invariant(vault.compareAndSet(ROW, undefined, state), 'SIGNAL_INITIALIZATION_CONFLICT');
  return publicDescriptor(state);
}
export function signalIdentityDescriptor(vault) {
  const state = vault.read(ROW)?.value; invariant(state?.version === 1 && state.protocol === PROTOCOL, 'SIGNAL_IDENTITY_MISSING');
  return publicDescriptor(state);
}

/** Maintained upstream Signal protocol, not a custom key-establishment scheme.
 * This package owns only identity policy, bounded framing and transactional store
 * callbacks. No ciphertext/plaintext is returned before its ratchet state commits.
 */
export class SignalParentChannel {
  #vault; #scope; #localRegistry; #own; #clock; #peers = new Map();
  #closed = false; #busy = false; #generation = 0; #lastNow;
  constructor({ vault, scope, localRegistry, nowUnixMs }) {
    scopeCheck(scope); invariant(typeof nowUnixMs === 'function', 'PARENT_CLOCK_REQUIRED');
    this.#vault = vault; this.#scope = snapshot(scope); this.#localRegistry = localRegistry; this.#clock = nowUnixMs;
    const state = vault.read(ROW)?.value;
    invariant(state?.version === 1 && state.protocol === PROTOCOL && canonicalJson(state.scope) === canonicalJson(scope), 'PARENT_IDENTITY_SCOPE_MISMATCH');
    this.#own = publicDescriptor(state); this.#lastNow = state.lastNowMs;
    this.#checkOwn(); this.#now();
  }
  get publicIdentity() { return snapshot(this.#own); }
  #now() {
    const now = this.#clock();
    try { integer(now, this.#lastNow); } catch { this.close(); throw new Error('PARENT_CLOCK_ROLLBACK'); }
    this.#lastNow = now; return now;
  }
  #checkOwn() {
    invariant(!this.#closed, 'PARENT_CHANNEL_CLOSED');
    const current = activeDevice(this.#localRegistry, this.#own.device.id, this.#scope);
    invariant(current.identityId === this.#own.identityId && canonicalJson(noStatus(current.device)) === canonicalJson(this.#own.device), 'PARENT_LOCAL_IDENTITY_CHANGED');
  }
  /** Called only by trusted endpoint policy after root-event verification. No TOFU,
   * remote self-enrollment, implicit wildcard permission or identity auto-replacement.
   */
  authorizePeer(registry, deviceId, { send, receive, expiresAtMs }) {
    this.#checkOwn(); const now = this.#now(); const current = activeDevice(registry, deviceId, this.#scope);
    for (const roles of [send, receive]) invariant(Array.isArray(roles) && roles.length <= 3 &&
      new Set(roles).size === roles.length && roles.every(kind => KINDS.includes(kind)), 'PARENT_INVALID_ROLES');
    integer(expiresAtMs, now + 1, now + MAX_LIFETIME_MS);
    const address = addressFor(this.#scope, current.identityId, deviceId, current.device.generation);
    invariant(address !== this.#own.address && (this.#peers.has(address) || this.#peers.size < 32), 'PARENT_PEER_LIMIT');
    this.#generation++;
    this.#peers.set(address, { registry, deviceId, fingerprint: digest(current), record: snapshot(current),
      send: [...send], receive: [...receive], expiresAtMs });
    return address;
  }
  revokePeer(address) { this.#generation++; this.#peers.delete(address); }
  #peer(address, kind, direction) {
    this.#checkOwn(); const peer = this.#peers.get(address);
    invariant(peer && peer.expiresAtMs > this.#now(), 'PARENT_PEER_NOT_AUTHORIZED');
    const current = activeDevice(peer.registry, peer.deviceId, this.#scope);
    invariant(digest(current) === peer.fingerprint, 'PARENT_PEER_IDENTITY_CHANGED');
    if (kind) invariant(peer[direction].includes(kind), 'PARENT_KIND_NOT_AUTHORIZED');
    return peer;
  }
  requirePeer(address, kind, direction = 'receive') {
    invariant(KINDS.includes(kind), 'PARENT_INVALID_KIND');
    invariant(direction === 'receive' || direction === 'send', 'PARENT_INVALID_DIRECTION');
    const peer = this.#peer(address, kind, direction);
    return snapshot({ ...peer.record, expiresAtMs: peer.expiresAtMs });
  }
  async controlPublicKey(address) {
    const { record } = this.#peer(address, 'control', 'receive');
    return crypto.subtle.importKey('raw', Buffer.from(record.device.signing.publicKeyHex, 'hex'), 'Ed25519', false, ['verify']);
  }
  async localControlKey() {
    this.#checkOwn(); const generation = this.#generation;
    const key = await signingKey(this.#vault.read(ROW).value);
    invariant(generation === this.#generation, 'PARENT_OPERATION_SUPERSEDED'); this.#checkOwn(); return key;
  }
  async #work(address, kind, direction, callback, validateResult) {
    this.#checkOwn(); invariant(!this.#busy, 'PARENT_OPERATION_BUSY');
    const peer = address ? this.#peer(address, kind, direction) : undefined;
    const generation = this.#generation; this.#busy = true;
    let result;
    try {
      const row = this.#vault.read(ROW); const state = row?.value;
      invariant(state?.protocol === PROTOCOL && canonicalJson(publicDescriptor(state)) === canonicalJson(this.#own), 'PARENT_STORED_IDENTITY_CHANGED');
      const now = this.#now(); integer(now, state.lastNowMs);
      for (const collection of [state.preKeys, state.kyberKeys]) for (const [id, entry] of Object.entries(collection)) {
        if (entry.expiresAtMs <= now) delete collection[id];
      }
      result = await callback(state, peer, now);
      invariant(generation === this.#generation && !this.#closed, 'PARENT_OPERATION_SUPERSEDED');
      this.#checkOwn(); if (address) this.#peer(address, kind, direction);
      state.lastNowMs = this.#now();
      if (Object.hasOwn(state, 'deliveryJournal')) checkJournal(journalFor(state, state.lastNowMs));
      if (validateResult) validateResult(result, state.lastNowMs);
      state.lastNowMs = this.#lastNow;
      invariant(Object.keys(state.sessions).length <= 32 && Object.keys(state.preKeys).length <= 64 &&
        Object.keys(state.kyberKeys).length <= 64, 'PARENT_STATE_LIMIT');
      invariant(this.#vault.compareAndSet(ROW, row.revision, state), 'PARENT_STATE_CONFLICT');
      return result;
    } finally { this.#busy = false; }
  }
  #stores(state, peer, address, now) {
    const expected = Buffer.from('05' + peer.record.device.agreement.publicKeyHex, 'hex');
    const requireAddress = addr => invariant(addr.name() === address && addr.deviceId() === ADDRESS_DEVICE, 'SIGNAL_STORE_SCOPE_MISMATCH');
    const requireKey = (addr, key) => { requireAddress(addr); invariant(Buffer.from(key.serialize()).equals(expected), 'SIGNAL_IDENTITY_NOT_TRUSTED'); };
    const sessions = {
      async saveSession(addr, record) { requireAddress(addr); state.sessions[address] = serializePrivate(record); },
      async getSession(addr) { requireAddress(addr); return state.sessions[address] ? signal.SessionRecord.deserialize(bytes64(state.sessions[address], 524288)) : null; },
      async getExistingSessions(addresses) { invariant(addresses.length <= 32, 'SIGNAL_STORE_LIMIT'); return Promise.all(addresses.map(async addr => { const value = await this.getSession(addr); invariant(value, 'SIGNAL_SESSION_MISSING'); return value; })); }
    };
    const identity = {
      async getIdentityKey() { return signal.PrivateKey.deserialize(bytes64(state.identityPrivate, 32, 32)); },
      async getIdentityKeyPair() { const privateKey = await this.getIdentityKey(); return new signal.IdentityKeyPair(privateKey.getPublicKey(), privateKey); },
      async getLocalRegistrationId() { return state.registrationId; },
      async saveIdentity(addr, key) { requireKey(addr, key); return signal.IdentityChange.NewOrUnchanged; },
      async isTrustedIdentity(addr, key) { requireKey(addr, key); return true; },
      async getIdentity(addr) { requireAddress(addr); return signal.PublicKey.deserialize(expected); }
    };
    const load = (collection, id, Class) => {
      integer(id, 1, 0x7fffffff); const entry = collection[id];
      invariant(entry && entry.expiresAtMs > now, 'SIGNAL_PREKEY_MISSING_OR_USED');
      return Class.deserialize(bytes64(entry.record, 16384));
    };
    const prekeys = {
      async getPreKey(id) { return load(state.preKeys, id, signal.PreKeyRecord); },
      async removePreKey(id) { invariant(state.preKeys[id], 'SIGNAL_PREKEY_MISSING_OR_USED'); delete state.preKeys[id]; },
      async savePreKey() { throw new Error('SIGNAL_UNEXPECTED_STORE_WRITE'); }
    };
    const signed = {
      async getSignedPreKey(id) { invariant(id === 1, 'SIGNAL_SIGNED_PREKEY_MISSING'); return signal.SignedPreKeyRecord.deserialize(bytes64(state.signedPreKey, 1024)); },
      async saveSignedPreKey() { throw new Error('SIGNAL_UNEXPECTED_STORE_WRITE'); }
    };
    const kyber = {
      async getKyberPreKey(id) { return load(state.kyberKeys, id, signal.KyberPreKeyRecord); },
      async markKyberPreKeyUsed(id) { invariant(state.kyberKeys[id], 'SIGNAL_PREKEY_MISSING_OR_USED'); delete state.kyberKeys[id]; },
      async saveKyberPreKey() { throw new Error('SIGNAL_UNEXPECTED_STORE_WRITE'); }
    };
    return { sessions, identity, prekeys, signed, kyber };
  }
  async publicBundle() {
    return this.#work(null, null, null, async (state, _peer, now) => {
      invariant(state.nextPreKeyId < 0x7fffffff && Object.keys(state.preKeys).length < 64 &&
        Object.keys(state.kyberKeys).length < 64, 'SIGNAL_PREKEY_LIMIT');
      const id = ++state.nextPreKeyId, expiresAtMs = now + MAX_LIFETIME_MS;
      const identity = signal.PrivateKey.deserialize(bytes64(state.identityPrivate, 32, 32));
      const ec = signal.PrivateKey.generate(), kem = signal.KEMKeyPair.generate();
      const ecRecord = signal.PreKeyRecord.new(id, ec.getPublicKey(), ec);
      const kemRecord = signal.KyberPreKeyRecord.new(id, now, kem, identity.sign(kem.getPublicKey().serialize()));
      const signed = signal.SignedPreKeyRecord.deserialize(bytes64(state.signedPreKey, 1024));
      state.preKeys[id] = { record: serializePrivate(ecRecord), expiresAtMs };
      state.kyberKeys[id] = { record: serializePrivate(kemRecord), expiresAtMs };
      const body = { protocol: PROTOCOL, scope: this.#scope, address: state.address, issuedAtMs: now, expiresAtMs,
        registrationId: state.registrationId, deviceId: ADDRESS_DEVICE,
        identityKey: b64(identity.getPublicKey().serialize()), preKeyId: id, preKey: b64(ec.getPublicKey().serialize()),
        signedPreKeyId: 1, signedPreKey: b64(signed.publicKey().serialize()), signedPreKeySignature: b64(signed.signature()),
        kyberPreKeyId: id, kyberPreKey: b64(kem.getPublicKey().serialize()), kyberPreKeySignature: b64(kemRecord.signature()) };
      const signature = b64(new Uint8Array(await crypto.subtle.sign('Ed25519', await signingKey(state),
        jsonBytes({ domain: 'DAE-SIGNAL-PUBLIC-BUNDLE-v1', body }))));
      return { body, signature };
    });
  }
  async connect(address, bundle) {
    // Snapshot and bound before asynchronous verification.
    const copy = snapshot(bundle); invariant(jsonBytes(copy).length <= 16384, 'PARENT_BUNDLE_LIMIT');
    exact(copy, ['body', 'signature']);
    const body = copy.body;
    exact(body, ['protocol', 'scope', 'address', 'issuedAtMs', 'expiresAtMs', 'registrationId', 'deviceId',
      'identityKey', 'preKeyId', 'preKey', 'signedPreKeyId', 'signedPreKey', 'signedPreKeySignature',
      'kyberPreKeyId', 'kyberPreKey', 'kyberPreKeySignature']);
    invariant(body.protocol === PROTOCOL && canonicalJson(body.scope) === canonicalJson(this.#scope) && body.address === address,
      'PARENT_BUNDLE_SCOPE_MISMATCH');
    return this.#work(address, null, null, async (state, peer, now) => {
      invariant(!state.sessions[address], 'SIGNAL_SESSION_ALREADY_EXISTS');
      assertLifetime(body.issuedAtMs, body.expiresAtMs, now);
      invariant(body.deviceId === ADDRESS_DEVICE, 'PARENT_BUNDLE_DEVICE_MISMATCH');
      integer(body.registrationId, 1, 16383);
      for (const id of [body.preKeyId, body.signedPreKeyId, body.kyberPreKeyId]) integer(id, 1, 0x7fffffff);
      const key = bytes64(body.identityKey, 33, 33);
      invariant(hex(key) === '05' + peer.record.device.agreement.publicKeyHex, 'PARENT_BUNDLE_IDENTITY_MISMATCH');
      invariant(await verifyEd(peer.record.device.signing.publicKeyHex, copy.signature,
        jsonBytes({ domain: 'DAE-SIGNAL-PUBLIC-BUNDLE-v1', body })), 'PARENT_BUNDLE_SIGNATURE_FAILED');
      const stores = this.#stores(state, peer, address, now);
      try {
        const prekey = signal.PreKeyBundle.new(body.registrationId, body.deviceId,
          body.preKeyId, signal.PublicKey.deserialize(bytes64(body.preKey, 33, 33)),
          body.signedPreKeyId, signal.PublicKey.deserialize(bytes64(body.signedPreKey, 33, 33)),
          bytes64(body.signedPreKeySignature, 64, 64), signal.PublicKey.deserialize(key),
          body.kyberPreKeyId, signal.KEMPublicKey.deserialize(bytes64(body.kyberPreKey, 4096)),
          bytes64(body.kyberPreKeySignature, 64, 64));
        await signal.processPreKeyBundle(prekey, signal.ProtocolAddress.new(address, ADDRESS_DEVICE),
          signal.ProtocolAddress.new(state.address, ADDRESS_DEVICE), stores.sessions, stores.identity, new Date(now));
      } catch { throw new Error('SIGNAL_BUNDLE_REJECTED'); }
      assertLifetime(body.issuedAtMs, body.expiresAtMs, this.#now());
    });
  }
  async seal(address, kind, payload, options) {
    return this.#seal(address, kind, payload, options);
  }
  /** The caller must persist a stable request ID before initiating work. Retry
   * identical requests after an uncertain result; never generate a new ID.
   */
  async queueMessage(address, kind, payload, options) {
    const fields = snapshot(options); exact(fields, ['messageId', 'expiresAtMs']);
    return this.#seal(address, kind, payload, fields, true);
  }
  async queueControl(address, fields, payload, options) {
    const copy = snapshot(fields), ids = snapshot(options);
    exact(ids, ['messageId']); exact(copy, ['epoch', 'sequence', 'issuedAtMs', 'expiresAtMs', 'action']);
    invariant(['lease', 'emergency-stop'].includes(copy.action), 'PARENT_UNSUPPORTED_CONTROL');
    integer(copy.epoch, 1); integer(copy.sequence, 1); integer(copy.issuedAtMs);
    integer(copy.expiresAtMs, copy.issuedAtMs + 1, copy.issuedAtMs + 60_000);
    const body = { version: '1.0.0', scope: this.#scope, keyId: this.#own.device.signing.id,
      algorithm: 'ALG-ED25519', ...copy };
    return this.#seal(address, 'control', { header: body, value: snapshot(payload) },
      { messageId: ids.messageId, expiresAtMs: copy.expiresAtMs }, true, body);
  }
  async #seal(address, kind, payload, { messageId, expiresAtMs }, queued = false, controlHeader) {
    identifier(messageId); invariant(KINDS.includes(kind), 'PARENT_INVALID_KIND');
    const copy = snapshot(payload);
    const request = queued ? { address, kind, messageId, expiresAtMs, payload: copy,
      recordType: controlHeader ? 'control' : 'signal' } : undefined;
    const requestDigest = queued ? digest(request) : undefined;
    return this.#work(address, kind, 'send', async (state, peer, now) => {
      assertLifetime(now, expiresAtMs, now); invariant(expiresAtMs <= peer.expiresAtMs, 'PARENT_PERMISSION_TOO_SHORT');
      const journal = queued ? journalFor(state, now) : undefined;
      if (journal) {
        const previous = findOutgoing(journal, messageId, requestDigest);
        if (previous) return deliveryView(previous);
      }
      invariant(state.sessions[address], 'SIGNAL_SESSION_MISSING');
      const envelope = { domain: 'DAE-SIGNAL-PARENT-v1', protocol: PROTOCOL, scope: this.#scope,
        from: state.address, to: address, kind, messageId, issuedAtMs: now, expiresAtMs, payload: copy };
      const plaintext = jsonBytes(envelope); invariant(plaintext.length <= MAX_MESSAGE_BYTES, 'PARENT_MESSAGE_LIMIT');
      const stores = this.#stores(state, peer, address, now); let ciphertext;
      try {
        const encrypted = await signal.signalEncrypt(plaintext, signal.ProtocolAddress.new(address, ADDRESS_DEVICE),
          signal.ProtocolAddress.new(state.address, ADDRESS_DEVICE), stores.sessions, stores.identity, new Date(now));
        invariant([signal.CiphertextMessageType.PreKey, signal.CiphertextMessageType.Whisper].includes(encrypted.type()), 'SIGNAL_MESSAGE_TYPE_REJECTED');
        ciphertext = encrypted.serialize();
        const wire = { protocol: PROTOCOL, from: state.address, to: address, messageType: encrypted.type(), ciphertext: b64(ciphertext) };
        invariant(jsonBytes(wire).length <= MAX_WIRE_BYTES, 'PARENT_WIRE_LIMIT');
        let record = wire;
        if (controlHeader) {
          assertLifetime(controlHeader.issuedAtMs, controlHeader.expiresAtMs, this.#now());
          record = await signControl({ ...controlHeader, payloadCiphertextBase64: jsonBytes(wire).toString('base64') },
            await signingKey(state));
        }
        assertLifetime(now, expiresAtMs, this.#now());
        return journal ? deliveryView(saveOutgoing(journal, request, requestDigest, request.recordType, record)) : wire;
      } finally { plaintext.fill(0); ciphertext?.fill(0); }
    }, (_result, now) => invariant(expiresAtMs > now, 'PARENT_EXPIRED_OR_FUTURE'));
  }
  async receive(wire, expectedKind) { return this.#receive(wire, expectedKind); }
  /** Persist authenticated plaintext with consumed ratchet state, before release.
   * Repeated ciphertext returns the same pending message or completed tombstone.
   */
  async receiveQueued(wire, expectedKind) { return this.#receive(wire, expectedKind, true); }
  /** Durable relay intake. Authenticates signed controls without consuming the
   * separate execution checkpoint, then binds and saves the complete packet with
   * receiving ratchet state. A stored command is NOT permission to execute it.
   */
  async receivePacket(packet, expectedSender) {
    const copy = snapshot(packet);
    invariant(jsonBytes(copy).length <= 70_000, 'PARENT_PACKET_LIMIT');
    exact(copy, ['deliveryId', 'recordType', 'record', 'expiresAtMs']);
    identifier(copy.deliveryId); integer(copy.expiresAtMs);
    invariant(['signal', 'control'].includes(copy.recordType), 'PARENT_PACKET_TYPE');
    let wire = copy.record;
    if (copy.recordType === 'control') {
      exact(copy.record, ['body', 'signatureHex']);
      wire = parseCanonicalJson(new TextDecoder('utf-8', { fatal: true }).decode(
        bytes64(copy.record.body.payloadCiphertextBase64, MAX_WIRE_BYTES)));
    }
    invariant(wire.from === expectedSender, 'PARENT_RELAY_SENDER_MISMATCH');
    return this.#receive(wire, copy.recordType === 'control' ? 'control' : undefined, true, copy);
  }
  async #receive(wire, expectedKind, queued = false, packet) {
    const copy = snapshot(wire); invariant(jsonBytes(copy).length <= MAX_WIRE_BYTES, 'PARENT_WIRE_LIMIT');
    exact(copy, ['protocol', 'from', 'to', 'messageType', 'ciphertext']);
    invariant(copy.protocol === PROTOCOL && copy.to === this.#own.address, 'PARENT_WIRE_SCOPE_MISMATCH');
    invariant([signal.CiphertextMessageType.PreKey, signal.CiphertextMessageType.Whisper].includes(copy.messageType), 'PARENT_MESSAGE_TYPE_REJECTED');
    const ciphertext = bytes64(copy.ciphertext, MAX_WIRE_BYTES);
    if (expectedKind !== undefined) invariant(KINDS.includes(expectedKind), 'PARENT_INVALID_KIND');
    return this.#work(copy.from, expectedKind, 'receive', async (state, peer, now) => {
      if (packet) {
        integer(packet.expiresAtMs, now + 1, now + MAX_LIFETIME_MS);
        if (packet.recordType === 'control') {
          const key = await crypto.subtle.importKey('raw', Buffer.from(peer.record.device.signing.publicKeyHex, 'hex'),
            'Ed25519', false, ['verify']);
          await authenticateControl(packet.record, { scope: this.#scope,
            signers: new Map([[peer.record.device.signing.id, key]]), actions: new Set(['lease', 'emergency-stop']) }, now);
        }
      }
      const bind = message => {
        if (!packet) return;
        invariant(message.messageId === packet.deliveryId && message.expiresAtMs === packet.expiresAtMs,
          'PARENT_PACKET_BINDING');
        if (packet.recordType === 'control') {
          exact(message.payload, ['header', 'value']);
          const { payloadCiphertextBase64: _wire, ...header } = packet.record.body;
          invariant(canonicalJson(message.payload.header) === canonicalJson(header), 'PARENT_CONTROL_HEADER_MISMATCH');
        } else invariant(message.kind !== 'control', 'PARENT_CONTROL_SIGNATURE_REQUIRED');
      };
      const journal = queued ? journalFor(state, now) : undefined;
      if (journal) {
        const previous = findIncoming(journal, copy);
        if (previous) {
          if (packet) invariant(previous.packetDigest === digest(packet), 'JOURNAL_PACKET_CONFLICT');
          this.#peer(copy.from, previous.kind, 'receive');
          invariant(!expectedKind || expectedKind === previous.kind, 'PARENT_KIND_MISMATCH');
          return incomingView(previous);
        }
      }
      const stores = this.#stores(state, peer, copy.from, now);
      const remote = signal.ProtocolAddress.new(copy.from, ADDRESS_DEVICE), local = signal.ProtocolAddress.new(state.address, ADDRESS_DEVICE);
      let plaintext;
      try {
        try {
          plaintext = copy.messageType === signal.CiphertextMessageType.PreKey
            ? await signal.signalDecryptPreKey(signal.PreKeySignalMessage.deserialize(ciphertext), remote, local,
                stores.sessions, stores.identity, stores.prekeys, stores.signed, stores.kyber)
            : await signal.signalDecrypt(signal.SignalMessage.deserialize(ciphertext), remote, local, stores.sessions, stores.identity);
        } catch { throw new Error('SIGNAL_AUTHENTICATION_OR_REPLAY_FAILED'); }
        invariant(plaintext.length <= MAX_MESSAGE_BYTES, 'PARENT_MESSAGE_LIMIT');
        const envelope = parseCanonicalJson(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
        exact(envelope, ['domain', 'protocol', 'scope', 'from', 'to', 'kind', 'messageId', 'issuedAtMs', 'expiresAtMs', 'payload']);
        invariant(envelope.domain === 'DAE-SIGNAL-PARENT-v1' && envelope.protocol === PROTOCOL &&
          canonicalJson(envelope.scope) === canonicalJson(this.#scope) && envelope.from === copy.from &&
          envelope.to === copy.to, 'PARENT_INNER_BINDING_MISMATCH');
        invariant(KINDS.includes(envelope.kind) && (!expectedKind || envelope.kind === expectedKind), 'PARENT_KIND_MISMATCH');
        this.#peer(copy.from, envelope.kind, 'receive'); identifier(envelope.messageId);
        assertLifetime(envelope.issuedAtMs, envelope.expiresAtMs, this.#now());
        bind(envelope);
        return journal ? incomingView(saveIncoming(journal, copy, envelope, packet)) : envelope;
      } finally { plaintext?.fill(0); }
    }, (result, now) => invariant(result.expiresAtMs > now, 'PARENT_EXPIRED_OR_FUTURE'));
  }
  async pendingDeliveries(address) {
    this.#peer(address, null, null);
    return this.#work(address, null, null, async (state, _peer, now) => {
      const entries = journalFor(state, now).outgoing.filter(entry => entry.recipient === address && entry.status === 'pending');
      for (const entry of entries) this.#peer(address, entry.kind, 'send');
      return entries.map(deliveryView);
    }, (entries, now) => invariant(entries.every(entry => entry.packet.expiresAtMs > now), 'PARENT_EXPIRED_OR_FUTURE'));
  }
  async markDeliverySent(deliveryId) {
    identifier(deliveryId);
    return this.#work(null, null, null, async (state, _peer, now) => {
      const journal = journalFor(state, now), entry = journal.outgoing.find(item => item.deliveryId === deliveryId);
      invariant(entry, 'JOURNAL_DELIVERY_UNAVAILABLE'); this.#peer(entry.recipient, entry.kind, 'send');
      return markSent(journal, deliveryId);
    }, (entry, now) => { this.#peer(entry.recipient, entry.kind, 'send');
      invariant(entry.packet.expiresAtMs > this.#lastNow, 'PARENT_EXPIRED_OR_FUTURE'); });
  }
  async pendingMessages(address) {
    this.#peer(address, null, null);
    return this.#work(address, null, null, async (state, _peer, now) => {
      const entries = journalFor(state, now).incoming.filter(entry => entry.sender === address && entry.status === 'pending');
      for (const entry of entries) this.#peer(address, entry.kind, 'receive');
      return entries.map(incomingView);
    }, (entries, now) => invariant(entries.every(entry => entry.expiresAtMs > now), 'PARENT_EXPIRED_OR_FUTURE'));
  }
  async completeMessage(messageKey) {
    return this.#work(null, null, null, async (state, _peer, now) => {
      const journal = journalFor(state, now), entry = journal.incoming.find(item => item.messageKey === messageKey);
      invariant(entry, 'JOURNAL_MESSAGE_UNAVAILABLE'); this.#peer(entry.sender, entry.kind, 'receive');
      return completeIncoming(journal, messageKey);
    }, (entry, now) => { this.#peer(entry.sender, entry.kind, 'receive');
      invariant(entry.expiresAtMs > this.#lastNow, 'PARENT_EXPIRED_OR_FUTURE'); });
  }
  /** Expiry maintenance only. It never authorizes, renders or resumes playback. */
  async sweepJournal() {
    return this.#work(null, null, null, async (state, _peer, now) => {
      journalFor(state, now);
    });
  }
  close() { this.#closed = true; this.#generation++; this.#peers.clear(); }
}
