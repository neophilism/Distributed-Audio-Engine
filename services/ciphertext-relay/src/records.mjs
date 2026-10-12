import { createHash } from 'node:crypto';
import { canonicalJson, parseCanonicalJson, integer, identifier, invariant } from '../../../dist/src/index.js';
export { canonicalJson, parseCanonicalJson, integer, identifier, invariant };
export const MAX_PACKET_BYTES = 70_000;
export const MAX_BODY_BYTES = 72_000;
export const MAX_CHUNK_BYTES = 256 * 1024 + 16;
export const MAX_CHUNK_BODY_BYTES = 360_000;
export const MAX_RESPONSE_BYTES = 600_000;
export const MAX_TTL_MS = 300_000;
export const PROTOCOL = 'signal-libsignal-0.105.0';
export const encode = value => Buffer.from(canonicalJson(value));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const digest = value => hash(encode(value));
export const clone = value => parseCanonicalJson(canonicalJson(value));
export const decode = bytes => parseCanonicalJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
export function exact(value, keys) {
  canonicalJson(value);
  invariant(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'RELAY_INVALID_RECORD');
}
export function address(value) { invariant(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'RELAY_INVALID_ADDRESS'); }
export function base64(value, maximum, length) {
  invariant(typeof value === 'string' && value.length <= Math.ceil(maximum / 3) * 4, 'RELAY_INVALID_BYTES');
  const raw = Buffer.from(value, 'base64');
  invariant(raw.toString('base64') === value && raw.length <= maximum && (!length || raw.length === length), 'RELAY_INVALID_BYTES');
  return raw;
}
export function signalRecord(value, from, to) {
  exact(value, ['protocol', 'from', 'to', 'messageType', 'ciphertext']);
  address(value.from); address(value.to);
  invariant(value.protocol === PROTOCOL && value.from === from && value.to === to &&
    [2, 3].includes(value.messageType), 'RELAY_RECORD_BINDING');
  invariant(base64(value.ciphertext, 49_152).length > 0, 'RELAY_EMPTY_CIPHERTEXT');
}
export function packetRecord(value, from, to, now) {
  exact(value, ['deliveryId', 'recordType', 'record', 'expiresAtMs']);
  address(from); address(to); identifier(value.deliveryId); integer(now);
  integer(value.expiresAtMs, now + 1, now + MAX_TTL_MS);
  if (value.recordType === 'signal') signalRecord(value.record, from, to);
  else {
    invariant(value.recordType === 'control', 'RELAY_UNSUPPORTED_RECORD');
    exact(value.record, ['body', 'signatureHex']);
    const body = value.record.body;
    exact(body, ['version', 'scope', 'keyId', 'algorithm', 'epoch', 'sequence', 'issuedAtMs', 'expiresAtMs', 'action', 'payloadCiphertextBase64']);
    exact(body.scope, ['tenantId', 'application', 'sessionId']);
    identifier(body.scope.tenantId); identifier(body.scope.sessionId); identifier(body.keyId);
    invariant(['scenesignal', 'distributed-radio'].includes(body.scope.application) &&
      ['lease', 'emergency-stop'].includes(body.action) && body.version === '1.0.0' && body.algorithm === 'ALG-ED25519', 'RELAY_UNSUPPORTED_CONTROL');
    integer(body.epoch, 1); integer(body.sequence, 1); integer(body.issuedAtMs, 0, now);
    integer(body.expiresAtMs, now + 1, body.issuedAtMs + 60_000);
    invariant(value.expiresAtMs <= body.expiresAtMs && typeof value.record.signatureHex === 'string' && /^[0-9a-f]{128}$/.test(value.record.signatureHex), 'RELAY_INVALID_CONTROL');
    signalRecord(decode(base64(body.payloadCiphertextBase64, 49_152)), from, to);
  }
  invariant(encode(value).length <= MAX_PACKET_BYTES, 'RELAY_PACKET_LIMIT');
}
export function publicBundle(value, owner, now) {
  exact(value, ['body', 'signature']);
  const body = value.body;
  exact(body, ['protocol', 'scope', 'address', 'issuedAtMs', 'expiresAtMs', 'registrationId', 'deviceId',
    'identityKey', 'preKeyId', 'preKey', 'signedPreKeyId', 'signedPreKey', 'signedPreKeySignature',
    'kyberPreKeyId', 'kyberPreKey', 'kyberPreKeySignature']);
  exact(body.scope, ['tenantId', 'application', 'sessionId']);
  identifier(body.scope.tenantId); identifier(body.scope.sessionId);
  invariant(['scenesignal', 'distributed-radio'].includes(body.scope.application) &&
    body.protocol === PROTOCOL && body.address === owner && body.deviceId === 1, 'RELAY_BUNDLE_BINDING');
  integer(body.issuedAtMs, 0, now); integer(body.expiresAtMs, now + 1, body.issuedAtMs + MAX_TTL_MS);
  integer(body.registrationId, 1, 16383);
  for (const id of [body.preKeyId, body.signedPreKeyId, body.kyberPreKeyId]) integer(id, 1, 0x7fffffff);
  for (const key of [body.identityKey, body.preKey, body.signedPreKey]) base64(key, 33, 33);
  invariant(base64(body.kyberPreKey, 4096).length > 0, 'RELAY_EMPTY_KEY');
  for (const signature of [value.signature, body.signedPreKeySignature, body.kyberPreKeySignature]) base64(signature, 64, 64);
  invariant(encode(value).length <= 16_384, 'RELAY_BUNDLE_LIMIT');
}

/** Ciphertext upload metadata is intentionally public to this relay. No private
 * manifest, filename, attachment key, nonce prefix or plaintext hash is accepted. */
export function chunkRecord(value, now) {
  exact(value, ['application', 'tenantId', 'storageObjectId', 'chunkIndex', 'ciphertextBase64', 'readers', 'expiresAtMs']);
  identifier(value.tenantId); identifier(value.storageObjectId);
  invariant(['scenesignal', 'distributed-radio'].includes(value.application), 'RELAY_INVALID_APPLICATION');
  integer(value.chunkIndex, 0, 16383); integer(value.expiresAtMs, now + 1, now + MAX_TTL_MS);
  invariant(Array.isArray(value.readers) && value.readers.length > 0 && value.readers.length <= 32 &&
    new Set(value.readers).size === value.readers.length, 'RELAY_READERS_LIMIT'); value.readers.forEach(address);
  const bytes = base64(value.ciphertextBase64, MAX_CHUNK_BYTES);
  invariant(bytes.length >= 16, 'RELAY_INVALID_CHUNK_SIZE'); return bytes;
}
