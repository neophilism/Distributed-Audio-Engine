import { canonicalJson, digest, exact, integer, invariant, jsonBytes, scopeCheck, snapshot, identifier } from './validation.mjs';

const ROW = 'controller-state';
const HASH = /^[0-9a-f]{64}$/;
const MAX_OPERATIONS = 64, MAX_STREAMS = 32, MAX_BYTES = 131072;
const address = value => invariant(typeof value === 'string' && HASH.test(value), 'CONTROLLER_INVALID_ADDRESS');
function requestOf(value) {
  return { recipient: value.recipient, action: value.action, payload: value.payload, expiresAtMs: value.expiresAtMs };
}
function validateRequest(value, now) {
  address(value.recipient);
  integer(value.expiresAtMs, now + 1, now + 60000);
  invariant(['lease', 'emergency-stop'].includes(value.action), 'CONTROLLER_INVALID_ACTION');
  if (value.action === 'emergency-stop') {
    invariant(value.payload === null, 'CONTROLLER_INVALID_EMERGENCY_PAYLOAD'); return;
  }
  exact(value.payload, ['expiresAtMs', 'stopAtMs', 'fadeMs', 'maxLinearGain']);
  const p = value.payload;
  integer(p.expiresAtMs, now + 1, value.expiresAtMs); integer(p.stopAtMs, now + 1);
  integer(p.fadeMs, 1, 30000);
  invariant(typeof p.maxLinearGain === 'number' && Number.isFinite(p.maxLinearGain) &&
    p.maxLinearGain >= 0 && p.maxLinearGain <= 1, 'CONTROLLER_INVALID_GAIN');
  invariant(p.fadeMs <= Math.min(p.expiresAtMs, p.stopAtMs) - now, 'CONTROLLER_INVALID_FADE');
}
function fingerprint(binding, operation) {
  return digest({ domain: 'DAE-CONTROLLER-INTENT-v1', binding, operationId: operation.operationId, request: requestOf(operation) });
}
function validateState(state, binding) {
  exact(state, ['version', 'binding', 'lastNowMs', 'streams', 'operations']);
  invariant(state.version === 1 && canonicalJson(state.binding) === canonicalJson(binding), 'CONTROLLER_BINDING_MISMATCH');
  integer(state.lastNowMs);
  invariant(Array.isArray(state.streams) && state.streams.length <= MAX_STREAMS &&
    Array.isArray(state.operations) && state.operations.length <= MAX_OPERATIONS, 'CONTROLLER_CAPACITY');
  invariant(jsonBytes(state).length <= MAX_BYTES, 'CONTROLLER_BYTE_LIMIT');
  const streams = new Map(), ids = new Set(), counters = new Set();
  for (const stream of state.streams) {
    exact(stream, ['recipient', 'epoch', 'sequence', 'reservationId']); address(stream.recipient);
    integer(stream.epoch, 1); integer(stream.sequence);
    invariant(stream.reservationId === null || typeof stream.reservationId === 'string', 'CONTROLLER_INVALID_RESERVATION');
    if (stream.reservationId !== null) identifier(stream.reservationId);
    invariant(!streams.has(stream.recipient), 'CONTROLLER_DUPLICATE_STREAM'); streams.set(stream.recipient, stream);
  }
  for (const operation of state.operations) {
    exact(operation, ['operationId', 'requestDigest', 'recipient', 'action', 'payload', 'epoch', 'sequence',
      'issuedAtMs', 'expiresAtMs', 'status']);
    identifier(operation.operationId); integer(operation.epoch, 1); integer(operation.sequence, 1);
    integer(operation.issuedAtMs, 0, state.lastNowMs); validateRequest(operation, operation.issuedAtMs);
    invariant(['reserved', 'queued'].includes(operation.status) &&
      operation.requestDigest === fingerprint(binding, operation), 'CONTROLLER_INVALID_OPERATION');
    const stream = streams.get(operation.recipient), counter = `${operation.recipient}:${operation.epoch}:${operation.sequence}`;
    invariant(stream && operation.epoch <= stream.epoch &&
      (operation.epoch < stream.epoch || operation.sequence <= stream.sequence) &&
      !ids.has(operation.operationId) && !counters.has(counter), 'CONTROLLER_INVALID_COUNTER');
    if (operation.epoch === stream.epoch && operation.status === 'reserved')
      invariant(stream.reservationId === operation.operationId, 'CONTROLLER_UNTRACKED_RESERVATION');
    ids.add(operation.operationId); counters.add(counter);
  }
  for (const stream of streams.values()) if (stream.reservationId !== null)
    invariant(state.operations.some(o => o.operationId === stream.reservationId && o.recipient === stream.recipient &&
      o.epoch === stream.epoch && o.sequence === stream.sequence && o.status === 'reserved'), 'CONTROLLER_MISSING_RESERVATION');
}

/** Endpoint-only durable issuance. Reservation precedes signing/ratchet work;
 * an uncertain result is resumed with identical IDs, counters and private payload.
 * Queued means durable ciphertext, never remote execution or audible playback.
 */
export class DurableSignalController {
  #vault; #channel; #clock; #binding; #identity; #closed = false; #busy = false; #lastNow = 0;
  constructor({ vault, channel, nowUnixMs }) {
    invariant(vault && typeof vault.read === 'function' && typeof vault.compareAndSet === 'function' &&
      channel && typeof channel.queueControl === 'function' && typeof nowUnixMs === 'function', 'CONTROLLER_CONFIGURATION');
    this.#vault = vault; this.#channel = channel; this.#clock = nowUnixMs;
    this.#identity = snapshot(channel.publicIdentity); scopeCheck(this.#identity.scope); address(this.#identity.address);
    this.#binding = { scope: this.#identity.scope, controller: this.#identity.address }; this.#load();
  }
  #open() {
    invariant(!this.#closed, 'CONTROLLER_CLOSED');
    invariant(canonicalJson(this.#channel.publicIdentity) === canonicalJson(this.#identity), 'CONTROLLER_IDENTITY_CHANGED');
  }
  #now() { const now = this.#clock(); integer(now, this.#lastNow); this.#lastNow = now; return now; }
  #load() {
    this.#open(); const row = this.#vault.read(ROW);
    const state = row?.value ?? { version: 1, binding: snapshot(this.#binding), lastNowMs: 0, streams: [], operations: [] };
    validateState(state, this.#binding); return { row, state };
  }
  #edit(edit) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const { row, state } = this.#load(), now = this.#now(); integer(now, state.lastNowMs); state.lastNowMs = now;
      const reservations = new Set(state.streams.map(s => s.reservationId));
      state.operations = state.operations.filter(o => o.expiresAtMs > now || reservations.has(o.operationId));
      const result = edit(state, now); validateState(state, this.#binding);
      if (this.#vault.compareAndSet(ROW, row?.revision, state)) return snapshot(result);
    }
    throw new Error('CONTROLLER_STATE_CONFLICT');
  }
  #peer(recipient, expiresAtMs) {
    this.#open(); address(recipient);
    const peer = this.#channel.requirePeer(recipient, 'control', 'send');
    if (expiresAtMs !== undefined) invariant(peer.expiresAtMs >= expiresAtMs, 'CONTROLLER_PERMISSION_TOO_SHORT');
    return peer;
  }
  #operation(state, operationId, now) {
    const operation = state.operations.find(o => o.operationId === operationId);
    invariant(operation, 'CONTROLLER_OPERATION_UNAVAILABLE');
    const stream = state.streams.find(s => s.recipient === operation.recipient);
    invariant(stream.epoch === operation.epoch, 'CONTROLLER_EPOCH_SUPERSEDED');
    invariant(operation.expiresAtMs > now &&
      (operation.action !== 'lease' || Math.min(operation.payload.expiresAtMs, operation.payload.stopAtMs) - now >= operation.payload.fadeMs),
      'CONTROLLER_OPERATION_EXPIRED');
    return operation;
  }
  async #send(operationId) {
    const { state } = this.#load(), now = this.#now(); integer(now, state.lastNowMs);
    const operation = snapshot(this.#operation(state, operationId, now));
    const peer = this.#peer(operation.recipient, operation.expiresAtMs);
    const fields = { epoch: operation.epoch, sequence: operation.sequence, issuedAtMs: operation.issuedAtMs,
      expiresAtMs: operation.expiresAtMs, action: operation.action };
    const result = await this.#channel.queueControl(operation.recipient, fields, operation.payload, { messageId: operationId });
    this.#open(); invariant(canonicalJson(peer) === canonicalJson(this.#peer(operation.recipient, operation.expiresAtMs)),
      'CONTROLLER_MEMBERSHIP_CHANGED');
    exact(result, ['recipient', 'kind', 'status', 'packet']); exact(result.packet, ['deliveryId', 'recordType', 'record', 'expiresAtMs']);
    exact(result.packet.record, ['body', 'signatureHex']);
    const body = result.packet.record.body, { payloadCiphertextBase64, ...header } = body;
    invariant(result.recipient === operation.recipient && result.kind === 'control' && ['pending', 'sent'].includes(result.status) &&
      result.packet.deliveryId === operationId && result.packet.recordType === 'control' && result.packet.expiresAtMs === operation.expiresAtMs &&
      typeof payloadCiphertextBase64 === 'string' && payloadCiphertextBase64.length > 0 && payloadCiphertextBase64.length <= 65536 &&
      /^[0-9a-f]{128}$/.test(result.packet.record.signatureHex) &&
      canonicalJson(header) === canonicalJson({ version: '1.0.0', scope: this.#identity.scope,
        keyId: this.#identity.device.signing.id, algorithm: 'ALG-ED25519', ...fields }), 'CONTROLLER_PACKET_MISMATCH');
    this.#edit((current, at) => {
      const saved = this.#operation(current, operationId, at);
      invariant(saved.requestDigest === operation.requestDigest, 'CONTROLLER_OPERATION_CHANGED');
      saved.status = 'queued'; const stream = current.streams.find(s => s.recipient === saved.recipient);
      if (stream.reservationId === operationId) stream.reservationId = null;
      return null;
    });
    return result;
  }
  async #run(work) {
    this.#open(); invariant(!this.#busy, 'CONTROLLER_BUSY'); this.#busy = true;
    try { return await work(); } finally { this.#busy = false; }
  }
  issue(source) {
    return this.#run(async () => {
      const request = snapshot(source);
      exact(request, ['operationId', 'recipient', 'action', 'payload', 'expiresAtMs']); identifier(request.operationId);
      const now = this.#now(); validateRequest(request, now); this.#peer(request.recipient, request.expiresAtMs);
      const requestDigest = fingerprint(this.#binding, request);
      this.#edit((state, at) => {
        const previous = state.operations.find(o => o.operationId === request.operationId);
        if (previous) {
          invariant(previous.requestDigest === requestDigest, 'CONTROLLER_OPERATION_ID_CONFLICT');
          return this.#operation(state, request.operationId, at).operationId;
        }
        let stream = state.streams.find(s => s.recipient === request.recipient);
        if (!stream) {
          invariant(state.streams.length < MAX_STREAMS, 'CONTROLLER_STREAM_LIMIT');
          stream = { recipient: request.recipient, epoch: 1, sequence: 0, reservationId: null }; state.streams.push(stream);
        }
        invariant(stream.reservationId === null, 'CONTROLLER_RESUME_OR_NEW_EPOCH_REQUIRED');
        invariant(state.operations.length < MAX_OPERATIONS, 'CONTROLLER_OPERATION_LIMIT');
        integer(stream.sequence + 1, 1); stream.sequence++; stream.reservationId = request.operationId;
        validateRequest(request, at);
        state.operations.push({ ...request, requestDigest, epoch: stream.epoch, sequence: stream.sequence,
          issuedAtMs: at, status: 'reserved' });
        return request.operationId;
      });
      return this.#send(request.operationId);
    });
  }
  resume(operationId) { return this.#run(() => { identifier(operationId); return this.#send(operationId); }); }
  /** Explicit reconciliation only. Does not retract sent ciphertext, stop remote
   * output, flush a relay, reset receiver checkpoints or start a fresh lease.
   */
  advanceEpoch(recipient, expectedEpoch) {
    this.#open(); this.#peer(recipient); integer(expectedEpoch); integer(expectedEpoch + 1, 1);
    return this.#edit(state => {
      let stream = state.streams.find(s => s.recipient === recipient);
      invariant((stream?.epoch ?? 0) === expectedEpoch, 'CONTROLLER_EPOCH_CONFLICT');
      if (!stream) {
        invariant(state.streams.length < MAX_STREAMS, 'CONTROLLER_STREAM_LIMIT');
        stream = { recipient, epoch: 0, sequence: 0, reservationId: null }; state.streams.push(stream);
      }
      stream.epoch++; stream.sequence = 0; stream.reservationId = null;
      return { epoch: stream.epoch, sequence: stream.sequence };
    });
  }
  streamState(recipient) {
    address(recipient); const { state } = this.#load(), now = this.#now(); integer(now, state.lastNowMs);
    const stream = state.streams.find(s => s.recipient === recipient);
    return stream ? snapshot(stream) : { recipient, epoch: 0, sequence: 0, reservationId: null };
  }
  pending() {
    const { state } = this.#load(), now = this.#now(); integer(now, state.lastNowMs);
    return state.operations.filter(o => o.status === 'reserved' && state.streams.some(s => s.reservationId === o.operationId))
      .map(o => ({ operationId: o.operationId, recipient: o.recipient, epoch: o.epoch, sequence: o.sequence,
        action: o.action, expiresAtMs: o.expiresAtMs, expired: o.expiresAtMs <= now ||
          (o.action === 'lease' && Math.min(o.payload.expiresAtMs, o.payload.stopAtMs) - now < o.payload.fadeMs) }));
  }
  close() { this.#closed = true; }
}
