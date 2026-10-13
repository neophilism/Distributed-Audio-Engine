import { test } from 'node:test';
import assert from 'node:assert/strict';
import { journalFor, checkJournal, findOutgoing, saveOutgoing, deliveryView, findIncoming,
  saveIncoming, incomingView, completeIncoming, markSent, MAX_JOURNAL_ENTRIES } from '../src/journal.mjs';
import { digest } from '../src/validation.mjs';

const from = 'a'.repeat(64), address = 'b'.repeat(64);
const request = (messageId = 'id') => ({ address, kind: 'manifest', messageId, expiresAtMs: 1000, payload: { private: true } });
const wire = n => ({ protocol: 'signal-libsignal-0.105.0', from, to: address, messageType: 2, ciphertext: Buffer.from(String(n)).toString('base64') });
const message = (messageId = 'id') => ({ domain: 'DAE-SIGNAL-PARENT-v1', protocol: 'signal-libsignal-0.105.0',
  scope: { tenantId: 'tenant', application: 'distributed-radio', sessionId: 'session' }, from, to: address,
  kind: 'manifest', messageId, issuedAtMs: 0, expiresAtMs: 1000, payload: { private: true } });

test('journal model: ciphertext-only outgoing records bind stable request IDs', () => {
  const state = {}, journal = journalFor(state, 1), req = request();
  const entry = saveOutgoing(journal, req, digest(req), 'signal', wire(1));
  assert.equal(findOutgoing(journal, 'id', digest(req)), entry);
  assert.throws(() => findOutgoing(journal, 'id', digest(request('different'))), /ID_CONFLICT/);
  assert.equal(JSON.stringify(journal).includes('private'), false);
  const view = deliveryView(entry); view.packet.record.ciphertext = 'changed';
  assert.notEqual(entry.packet.record.ciphertext, 'changed');
  assert.equal(markSent(journal, 'id').status, 'sent'); checkJournal(journal);
});

test('journal model: completion erases private payload but retains replay protection', () => {
  const state = {}, journal = journalFor(state, 1);
  const entry = saveIncoming(journal, wire(1), message());
  const view = incomingView(entry); view.message.payload.private = false;
  assert.equal(entry.message.payload.private, true);
  assert.equal(findIncoming(journal, wire(1)), entry);
  const tombstone = completeIncoming(journal, entry.messageKey);
  assert.equal(tombstone.status, 'completed'); assert.equal('message' in tombstone, false);
  assert.equal(JSON.stringify(journal).includes('private'), false);
  assert.throws(() => saveIncoming(journal, wire(2), message()), /MESSAGE_ID_CONFLICT/);
  assert.deepEqual(completeIncoming(journal, entry.messageKey), tombstone); checkJournal(journal);
});

test('journal model: quotas include tombstones; only expiry reclaims capacity', () => {
  const state = {}, journal = journalFor(state, 1);
  for (let i = 0; i < MAX_JOURNAL_ENTRIES; i++) {
    const entry = saveIncoming(journal, wire(i), message('m-' + i));
    completeIncoming(journal, entry.messageKey);
  }
  const candidate = structuredClone(journal);
  assert.throws(() => saveOutgoing(candidate, request(), digest(request()), 'signal', wire(99)), /ENTRY_LIMIT/);
  assert.equal(journalFor(state, 999).incoming.length, MAX_JOURNAL_ENTRIES);
  assert.equal(journalFor(state, 1000).incoming.length, 0);
});

test('journal model: malformed persisted records fail closed rather than reset replay state', () => {
  for (const corrupt of [null, { version: 2, outgoing: [], incoming: [] },
    { version: 1, outgoing: {}, incoming: [] }, { version: 1, outgoing: [], incoming: [], ignored: 1 }]) {
    assert.throws(() => journalFor({ deliveryJournal: corrupt }, 1));
  }
  const journal = journalFor({}, 1); saveIncoming(journal, wire(1), message());
  journal.incoming[0].message.messageId = 'replacement';
  assert.throws(() => checkJournal(journal), /MESSAGE_BINDING/);
});

test('journal model: byte quota refuses growth before a vault commit', () => {
  const journal = journalFor({}, 1);
  const huge = wire(1); huge.ciphertext = 'x'.repeat(524_288);
  assert.throws(() => saveOutgoing(journal, request(), digest(request()), 'signal', huge), /BYTE_LIMIT/);
});
