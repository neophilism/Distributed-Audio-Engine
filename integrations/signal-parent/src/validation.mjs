import { createHash } from 'node:crypto';
import { canonicalJson, parseCanonicalJson, identifier, integer, invariant } from '../../../dist/src/index.js';

export { canonicalJson, parseCanonicalJson, identifier, integer, invariant };
export const PROTOCOL = 'signal-libsignal-0.105.0';
export const MAX_WIRE_BYTES = 49_152;
export const MAX_MESSAGE_BYTES = 24_576;
export const MAX_LIFETIME_MS = 300_000;
export const jsonBytes = value => Buffer.from(canonicalJson(value), 'utf8');
export const digest = value => createHash('sha256').update(jsonBytes(value)).digest('hex');
export const snapshot = value => parseCanonicalJson(canonicalJson(value));
export function exact(value, keys) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), 'PARENT_INVALID_OBJECT');
  canonicalJson(value); // Reject accessors, exotic prototypes and ambiguous encodings.
  invariant(Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'PARENT_UNKNOWN_FIELDS');
}
export function bytes64(value, max = MAX_WIRE_BYTES, exactSize) {
  invariant(typeof value === 'string' && value.length <= Math.ceil(max / 3) * 4 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'PARENT_INVALID_BASE64');
  const bytes = Buffer.from(value, 'base64');
  invariant(bytes.toString('base64') === value && bytes.length <= max &&
    (exactSize === undefined || bytes.length === exactSize), 'PARENT_INVALID_BASE64');
  return bytes;
}
export function scopeCheck(scope) {
  exact(scope, ['tenantId', 'application', 'sessionId']);
  identifier(scope.tenantId); identifier(scope.sessionId);
  invariant(['scenesignal', 'distributed-radio'].includes(scope.application), 'PARENT_INVALID_SCOPE');
}
export function publicDescriptor(state) {
  return snapshot({ scope: state.scope, identityId: state.identityId, device: state.device, address: state.address });
}
export function addressFor(scope, identityId, deviceId, generation) {
  scopeCheck(scope); identifier(identityId); identifier(deviceId); integer(generation, 1);
  return digest({ domain: 'DAE-SIGNAL-ADDRESS-v1', scope, identityId, deviceId, generation });
}
export function assertLifetime(issued, expires, now) {
  integer(issued); integer(expires, issued + 1); integer(now);
  invariant(expires - issued <= MAX_LIFETIME_MS && issued <= now && now < expires, 'PARENT_EXPIRED_OR_FUTURE');
}
