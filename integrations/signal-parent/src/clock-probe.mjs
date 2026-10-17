import { canonicalJson, digest, exact, identifier, integer, invariant, snapshot } from './validation.mjs';

const CLOCK_PROBE = 'clock-probe';
const NONCE = /^[0-9a-f]{64}$/;

/** Start a bounded encrypted challenge using the existing authorized Signal
 * 'ack' channel. The clock captures the monotonic send instant before encryption,
 * so queue/network latency contributes to conservative uncertainty. No automatic
 * retries or background transport: caller owns relay flush, deadlines and storage. */
export async function queueSignalClockProbe({ channel, recipient, clock, messageId, expiresAtMs }) {
  invariant(channel && typeof channel.queueMessage === 'function' &&
    typeof channel.requirePeer === 'function' && clock &&
    typeof clock.beginProbe === 'function', 'PARENT_CLOCK_PROBE_CONFIGURATION');
  identifier(messageId); integer(expiresAtMs);
  const peer = channel.requirePeer(recipient, 'ack', 'send');
  const probe = snapshot(clock.beginProbe());
  exact(probe, ['nonce', 'sentMonoMs']);
  invariant(NONCE.test(probe.nonce) && typeof probe.sentMonoMs === 'number' &&
    Number.isFinite(probe.sentMonoMs) && probe.sentMonoMs >= 0, 'PARENT_CLOCK_PROBE_INVALID');
  const delivery = await channel.queueMessage(recipient, 'ack',
    { type: CLOCK_PROBE, nonce: probe.nonce }, { messageId, expiresAtMs });
  invariant(delivery?.recipient === recipient && delivery.kind === 'ack' &&
    delivery.packet?.recordType === 'signal' && delivery.packet.deliveryId === messageId,
    'PARENT_CLOCK_PROBE_DELIVERY_MISMATCH');
  invariant(canonicalJson(channel.requirePeer(recipient, 'ack', 'send')) === canonicalJson(peer),
    'PARENT_CLOCK_PROBE_MEMBERSHIP_CHANGED');
  return { probe, delivery };
}

/** Respond only to an already-authenticated durable inbox receipt from
 * SignalParentChannel.receivePacket. Never accept relay JSON as an inbox receipt.
 * The app supplies the trusted controller clock sampled at intake; replaying
 * the receipt resumes the original persisted signed response byte-for-byte.
 * Actual relay delivery, application completion and acoustic calibration remain
 * separate from this explicit helper. */
export async function respondSignalClockProbe({ channel, controller, receipt, receivedUnixMs, uncertaintyMs, nowUnixMs }) {
  invariant(channel && controller && typeof controller.issue === 'function' &&
    typeof controller.resume === 'function' && typeof nowUnixMs === 'function',
    'PARENT_CLOCK_RESPONSE_CONFIGURATION');
  const saved = snapshot(receipt);
  invariant(saved?.status === 'pending' && saved.kind === 'ack' &&
    typeof saved.sender === 'string' && saved.message &&
    typeof saved.message === 'object', 'PARENT_CLOCK_PROBE_RECEIPT');
  const message = saved.message, own = channel.publicIdentity;
  exact(message, ['domain', 'protocol', 'scope', 'from', 'to', 'kind', 'messageId', 'issuedAtMs', 'expiresAtMs', 'payload']);
  invariant(message.kind === 'ack' && message.from === saved.sender && message.to === own.address &&
    message.messageId === saved.messageId && message.expiresAtMs === saved.expiresAtMs &&
    canonicalJson(message.scope) === canonicalJson(own.scope), 'PARENT_CLOCK_PROBE_BINDING');
  exact(message.payload, ['type', 'nonce']);
  invariant(message.payload.type === CLOCK_PROBE && NONCE.test(message.payload.nonce), 'PARENT_CLOCK_PROBE_PAYLOAD');
  channel.requirePeer(saved.sender, 'ack', 'receive');
  channel.requirePeer(saved.sender, 'control', 'send');
  // Read back the committed authenticated inbox receipt, not caller-supplied JSON.
  const retained = (await channel.pendingMessages(saved.sender)).find(row => row.messageKey === saved.messageKey);
  invariant(retained && canonicalJson(retained) === canonicalJson(saved), 'PARENT_CLOCK_PROBE_NOT_AUTHENTICATED');
  invariant(Number.isFinite(uncertaintyMs) && uncertaintyMs >= 0 && uncertaintyMs <= 1000,
    'PARENT_CLOCK_REFERENCE_UNCERTAINTY');
  const now = nowUnixMs(); integer(now); integer(message.expiresAtMs, now + 1);
  invariant(Number.isFinite(receivedUnixMs) && receivedUnixMs >= 0 &&
    receivedUnixMs <= now && now - receivedUnixMs <= 5000, 'PARENT_CLOCK_PROBE_SAMPLE_TIME');
  const operationId = 'clock-' + digest({ domain: 'DAE-CLOCK-PROBE-REPLY-v1',
    scope: own.scope, from: saved.sender, messageId: message.messageId, nonce: message.payload.nonce });
  try {
    const delivery = await controller.resume(operationId);
    invariant(delivery?.recipient === saved.sender && delivery.packet?.recordType === 'control' &&
      delivery.packet.record.body.action === 'clock-response', 'PARENT_CLOCK_RESPONSE_RETRY_MISMATCH');
    return { operationId, delivery, reused: true };
  } catch (error) {
    if (error?.message !== 'CONTROLLER_OPERATION_UNAVAILABLE') throw error;
  }
  const delivery = await controller.issue({ operationId, recipient: saved.sender,
    action: 'clock-response', expiresAtMs: Math.min(message.expiresAtMs, now + 2500),
    payload: { nonce: message.payload.nonce, receivedUnixMs, sentUnixMs: now, uncertaintyMs } });
  invariant(delivery?.recipient === saved.sender && delivery.packet?.recordType === 'control' &&
    delivery.packet.record.body.action === 'clock-response', 'PARENT_CLOCK_RESPONSE_PACKET_MISMATCH');
  return { operationId, delivery, reused: false };
}
