import { digest, snapshot, exact, jsonBytes, identifier, integer, invariant } from './validation.mjs';

// Counts include tombstones: never evict unexpired replay protection to admit work.
export const MAX_JOURNAL_ENTRIES = 64;
export const MAX_JOURNAL_BYTES = 524_288;
const HASH = /^[0-9a-f]{64}$/;
const hash = value => invariant(typeof value === 'string' && HASH.test(value), 'JOURNAL_INVALID_HASH');
const kind = value => invariant(['manifest', 'control', 'ack'].includes(value), 'JOURNAL_INVALID_KIND');
const messageKeyFor = (from, messageId) => digest({ domain: 'DAE-INBOX-ID-v1', from, messageId });

/** This data MUST live inside the same encrypted CAS row as the Signal ratchet.
 * It is not a separate store, network queue, or a claim of exactly-once effects.
 */
export function journalFor(state, now) {
  integer(now);
  if (state.deliveryJournal === undefined) state.deliveryJournal = { version: 1, outgoing: [], incoming: [] };
  const journal = state.deliveryJournal;
  checkJournal(journal);
  journal.outgoing = journal.outgoing.filter(entry => entry.expiresAtMs > now);
  journal.incoming = journal.incoming.filter(entry => entry.expiresAtMs > now);
  return journal;
}

export function checkJournal(journal) {
  exact(journal, ['version', 'outgoing', 'incoming']);
  invariant(journal.version === 1 && Array.isArray(journal.outgoing) && Array.isArray(journal.incoming), 'JOURNAL_INVALID_STATE');
  invariant(journal.outgoing.length + journal.incoming.length <= MAX_JOURNAL_ENTRIES, 'JOURNAL_ENTRY_LIMIT');
  invariant(jsonBytes(journal).length <= MAX_JOURNAL_BYTES, 'JOURNAL_BYTE_LIMIT');
  const ids = new Set(), keys = new Set(), wires = new Set();
  for (const entry of journal.outgoing) {
    exact(entry, ['deliveryId', 'recipient', 'kind', 'requestDigest', 'expiresAtMs', 'status', 'packet']);
    identifier(entry.deliveryId); hash(entry.recipient); hash(entry.requestDigest); kind(entry.kind); integer(entry.expiresAtMs, 1);
    invariant(['pending', 'sent'].includes(entry.status) && !ids.has(entry.deliveryId), 'JOURNAL_INVALID_OUTGOING');
    exact(entry.packet, ['deliveryId', 'recordType', 'record', 'expiresAtMs']);
    invariant(entry.packet.deliveryId === entry.deliveryId && entry.packet.expiresAtMs === entry.expiresAtMs &&
      ['signal', 'control'].includes(entry.packet.recordType), 'JOURNAL_INVALID_PACKET');
    ids.add(entry.deliveryId);
  }
  for (const entry of journal.incoming) {
    const completed = entry.status === 'completed';
    exact(entry, ['messageKey', 'wireDigest', 'sender', 'kind', 'messageId', 'expiresAtMs', 'status', ...completed ? [] : ['message']]);
    hash(entry.messageKey); hash(entry.wireDigest); hash(entry.sender); kind(entry.kind); identifier(entry.messageId); integer(entry.expiresAtMs, 1);
    invariant(['pending', 'completed'].includes(entry.status) && !keys.has(entry.messageKey) && !wires.has(entry.wireDigest) &&
      entry.messageKey === messageKeyFor(entry.sender, entry.messageId), 'JOURNAL_INVALID_INCOMING');
    if (!completed) invariant(entry.message.from === entry.sender && entry.message.messageId === entry.messageId &&
      entry.message.kind === entry.kind && entry.message.expiresAtMs === entry.expiresAtMs, 'JOURNAL_MESSAGE_BINDING');
    keys.add(entry.messageKey); wires.add(entry.wireDigest);
  }
}

export function findOutgoing(journal, messageId, requestDigest) {
  const entry = journal.outgoing.find(item => item.deliveryId === messageId);
  invariant(!entry || entry.requestDigest === requestDigest, 'JOURNAL_REQUEST_ID_CONFLICT');
  return entry;
}
export function saveOutgoing(journal, request, requestDigest, recordType, record) {
  const entry = { deliveryId: request.messageId, recipient: request.address, kind: request.kind, requestDigest,
    expiresAtMs: request.expiresAtMs, status: 'pending',
    packet: { deliveryId: request.messageId, recordType, record: snapshot(record), expiresAtMs: request.expiresAtMs } };
  invariant(!findOutgoing(journal, request.messageId, requestDigest), 'JOURNAL_DUPLICATE_OUTGOING');
  journal.outgoing.push(entry); checkJournal(journal); return entry;
}
export function deliveryView(entry) {
  return snapshot({ recipient: entry.recipient, kind: entry.kind, status: entry.status, packet: entry.packet });
}
export function markSent(journal, deliveryId) {
  const entry = journal.outgoing.find(item => item.deliveryId === deliveryId);
  invariant(entry, 'JOURNAL_DELIVERY_UNAVAILABLE'); entry.status = 'sent'; return deliveryView(entry);
}

export function findIncoming(journal, wire) {
  const wireDigest = digest(wire);
  return journal.incoming.find(entry => entry.wireDigest === wireDigest);
}
export function saveIncoming(journal, wire, message) {
  const messageKey = messageKeyFor(message.from, message.messageId);
  invariant(!journal.incoming.some(entry => entry.messageKey === messageKey), 'JOURNAL_MESSAGE_ID_CONFLICT');
  const entry = { messageKey, wireDigest: digest(wire), sender: message.from, kind: message.kind,
    messageId: message.messageId, expiresAtMs: message.expiresAtMs, status: 'pending', message: snapshot(message) };
  journal.incoming.push(entry); checkJournal(journal); return entry;
}
export function incomingView(entry) {
  const { wireDigest: _digest, ...view } = entry; return snapshot(view);
}
export function completeIncoming(journal, messageKey) {
  hash(messageKey); const entry = journal.incoming.find(item => item.messageKey === messageKey);
  invariant(entry, 'JOURNAL_MESSAGE_UNAVAILABLE');
  delete entry.message; entry.status = 'completed'; return incomingView(entry);
}
