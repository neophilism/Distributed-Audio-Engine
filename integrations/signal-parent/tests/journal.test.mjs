import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, scope } from './helpers.mjs';
import { snapshot } from '../src/validation.mjs';
import { SignalParentChannel, EncryptedFileVault, SignalPlaybackInbox } from '../src/index.mjs';

function reopen(f, who, peer) {
  const revision = who.vault.revision; who.channel.close(); who.vault.close();
  who.vault = new EncryptedFileVault({ ...who.options, minimumRevision: revision });
  who.channel = new SignalParentChannel({ vault: who.vault, scope, localRegistry: who.registry, nowUnixMs: () => f.now });
  assert.throws(() => who.channel.requirePeer(peer.descriptor.address, 'manifest'), /NOT_AUTHORIZED/);
  f.authorize(who, peer);
}
const sessions = who => structuredClone(who.vault.read('signal-state').value.sessions);

test('journal: restart recovers identical outbound ciphertext without advancing the ratchet', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const options = f.messageOptions(), payload = { secret: 'never-at-relay' };
  const first = await f.alice.channel.queueMessage(f.bobId, 'manifest', payload, options), ratchet = sessions(f.alice);
  assert.equal(first.status, 'pending'); assert.equal(first.packet.deliveryId, options.messageId);
  reopen(f, f.alice, f.bob);
  assert.deepEqual(await f.alice.channel.pendingDeliveries(f.bobId), [first]);
  assert.deepEqual(await f.alice.channel.queueMessage(f.bobId, 'manifest', payload, options), first);
  assert.deepEqual(sessions(f.alice), ratchet);
  assert.equal((await f.bob.channel.receiveQueued(first.packet.record, 'manifest')).message.payload.secret, payload.secret);
  assert.equal(JSON.stringify(f.alice.vault.read('signal-state')).includes(payload.secret), false);
});

test('journal: crash after outbound commit but before return preserves the only wire record', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const options = f.messageOptions(), save = f.alice.vault.compareAndSet.bind(f.alice.vault);
  f.alice.vault.compareAndSet = (...args) => { assert.equal(save(...args), true); throw Error('crash-after-commit'); };
  await assert.rejects(f.alice.channel.queueMessage(f.bobId, 'ack', {}, options), /crash-after-commit/);
  reopen(f, f.alice, f.bob);
  const [pending] = await f.alice.channel.pendingDeliveries(f.bobId);
  assert.deepEqual(await f.alice.channel.queueMessage(f.bobId, 'ack', {}, options), pending);
  assert.equal((await f.bob.channel.receiveQueued(pending.packet.record)).message.messageId, options.messageId);
});

test('journal: crash after incoming commit recovers private message without decrypting a consumed ratchet', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const out = await f.alice.channel.queueMessage(f.bobId, 'manifest', { secret: 'private-recovery-payload' }, f.messageOptions());
  const save = f.bob.vault.compareAndSet.bind(f.bob.vault);
  f.bob.vault.compareAndSet = (...args) => { assert.equal(save(...args), true); throw Error('crash-after-commit'); };
  await assert.rejects(f.bob.channel.receiveQueued(out.packet.record), /crash-after-commit/);
  reopen(f, f.bob, f.alice);
  const ratchet = sessions(f.bob), [pending] = await f.bob.channel.pendingMessages(f.aliceId);
  assert.equal(pending.message.payload.secret, 'private-recovery-payload');
  assert.deepEqual(await f.bob.channel.receiveQueued(out.packet.record), pending); assert.deepEqual(sessions(f.bob), ratchet);
  const disk = readFileSync(join(f.bob.options.directory, 'signal.vault'));
  assert.equal(disk.includes(Buffer.from('private-recovery-payload')), false);
});

test('journal: failed outgoing CAS withholds ciphertext and rolls back the journal and ratchet together', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const initial = f.alice.vault.read('signal-state'), save = f.alice.vault.compareAndSet.bind(f.alice.vault);
  f.alice.vault.compareAndSet = () => false;
  await assert.rejects(f.alice.channel.queueMessage(f.bobId, 'ack', {}, f.messageOptions()), /STATE_CONFLICT/);
  assert.deepEqual(f.alice.vault.read('signal-state'), initial);
  f.alice.vault.compareAndSet = save;
  const out = await f.alice.channel.queueMessage(f.bobId, 'ack', {}, f.messageOptions());
  assert.equal((await f.bob.channel.receiveQueued(out.packet.record)).status, 'pending');
});

test('journal: failed incoming write preserves prekeys and allows an authentic retry', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const out = await f.alice.channel.queueMessage(f.bobId, 'ack', {}, f.messageOptions());
  const initial = f.bob.vault.read('signal-state'), save = f.bob.vault.compareAndSet.bind(f.bob.vault);
  f.bob.vault.compareAndSet = () => { throw Error('disk-failed'); };
  await assert.rejects(f.bob.channel.receiveQueued(out.packet.record), /disk-failed/);
  assert.deepEqual(f.bob.vault.read('signal-state'), initial);
  f.bob.vault.compareAndSet = save;
  assert.equal((await f.bob.channel.receiveQueued(out.packet.record)).status, 'pending');
});

test('journal: conflicting retry IDs cannot substitute payload, kind, recipient or lifetime', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect(); f.authorize(f.alice, f.eve);
  const options = f.messageOptions(); await f.alice.channel.queueMessage(f.bobId, 'manifest', { value: 1 }, options);
  const before = f.alice.vault.read('signal-state');
  for (const [address, kind, payload, fields] of [
    [f.bobId, 'manifest', { value: 2 }, options], [f.bobId, 'ack', { value: 1 }, options],
    [f.eve.descriptor.address, 'manifest', { value: 1 }, options],
    [f.bobId, 'manifest', { value: 1 }, { ...options, expiresAtMs: options.expiresAtMs + 1 }]]) {
    await assert.rejects(f.alice.channel.queueMessage(address, kind, payload, fields), /REQUEST_ID_CONFLICT/);
    assert.deepEqual(f.alice.vault.read('signal-state'), before);
  }
});

test('journal: sent marking is idempotent, retains packet, and never means recipient application', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect(); const options = f.messageOptions();
  const queued = await f.alice.channel.queueMessage(f.bobId, 'ack', {}, options);
  const sent = await f.alice.channel.markDeliverySent(options.messageId);
  assert.equal(sent.status, 'sent'); assert.deepEqual(sent.packet, queued.packet);
  assert.deepEqual(await f.alice.channel.markDeliverySent(options.messageId), sent);
  assert.deepEqual(await f.alice.channel.pendingDeliveries(f.bobId), []);
  reopen(f, f.alice, f.bob);
  assert.deepEqual(await f.alice.channel.queueMessage(f.bobId, 'ack', {}, options), sent);
  assert.equal((await f.bob.channel.receiveQueued(sent.packet.record)).status, 'pending');
});

test('journal: completed inbox entries erase payload and suppress redelivery across restart', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const out = await f.alice.channel.queueMessage(f.bobId, 'manifest', { secret: 'unique-private-data' }, f.messageOptions());
  const entry = await f.bob.channel.receiveQueued(out.packet.record, 'manifest');
  const done = await f.bob.channel.completeMessage(entry.messageKey);
  assert.equal(done.status, 'completed'); assert.equal('message' in done, false);
  assert.equal(JSON.stringify(f.bob.vault.read('signal-state')).includes('unique-private-data'), false);
  reopen(f, f.bob, f.alice);
  assert.deepEqual(await f.bob.channel.receiveQueued(out.packet.record, 'manifest'), done);
  assert.deepEqual(await f.bob.channel.pendingMessages(f.aliceId), []);
  assert.deepEqual(await f.bob.channel.completeMessage(entry.messageKey), done);
});

test('journal: sender re-encryption of a completed ID is rejected without consuming the new ratchet message', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const out = await f.alice.channel.queueMessage(f.bobId, 'ack', {}, f.messageOptions());
  const received = await f.bob.channel.receiveQueued(out.packet.record); await f.bob.channel.completeMessage(received.messageKey);
  // Deliberately emulate a sender that bypassed the durable API.
  const conflicting = await f.alice.channel.seal(f.bobId, 'ack', { replacement: true }, f.messageOptions());
  const before = f.bob.vault.read('signal-state');
  await assert.rejects(f.bob.channel.receiveQueued(conflicting), /MESSAGE_ID_CONFLICT/);
  assert.deepEqual(f.bob.vault.read('signal-state'), before);
  const next = await f.alice.channel.queueMessage(f.bobId, 'ack', {}, f.messageOptions('next'));
  assert.equal((await f.bob.channel.receiveQueued(next.packet.record)).messageId, 'next');
});

test('journal: cached redelivery still rejects ciphertext tampering, wrong kind and changed membership', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const out = await f.alice.channel.queueMessage(f.bobId, 'manifest', {}, f.messageOptions());
  const entry = await f.bob.channel.receiveQueued(out.packet.record);
  await assert.rejects(f.bob.channel.receiveQueued(out.packet.record, 'ack'), /KIND_MISMATCH/);
  const changed = structuredClone(out.packet.record), bytes = Buffer.from(changed.ciphertext, 'base64');
  bytes[bytes.length - 1] ^= 1; changed.ciphertext = bytes.toString('base64');
  await assert.rejects(f.bob.channel.receiveQueued(changed), /AUTHENTICATION_OR_REPLAY/);
  await f.rotate(f.alice);
  for (const attempt of [() => f.bob.channel.receiveQueued(out.packet.record),
    () => f.bob.channel.pendingMessages(f.aliceId), () => f.bob.channel.completeMessage(entry.messageKey)]) {
    await assert.rejects(attempt(), /IDENTITY_CHANGED/);
  }
});

test('journal: revoked recipient blocks pending ciphertext, retry and sent marking', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const options = f.messageOptions(); await f.alice.channel.queueMessage(f.bobId, 'ack', {}, options);
  await f.rotate(f.bob);
  for (const attempt of [() => f.alice.channel.pendingDeliveries(f.bobId),
    () => f.alice.channel.queueMessage(f.bobId, 'ack', {}, options), () => f.alice.channel.markDeliverySent(options.messageId)]) {
    await assert.rejects(attempt(), /IDENTITY_CHANGED/);
  }
});

test('journal: expiry prunes payloads and packets; a consumed old wire is never reaccepted', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect(); const options = f.messageOptions();
  const out = await f.alice.channel.queueMessage(f.bobId, 'ack', {}, options);
  await f.bob.channel.receiveQueued(out.packet.record); f.setNow(options.expiresAtMs);
  await f.alice.channel.sweepJournal(); await f.bob.channel.sweepJournal();
  assert.deepEqual(await f.alice.channel.pendingDeliveries(f.bobId), []);
  assert.deepEqual(await f.bob.channel.pendingMessages(f.aliceId), []);
  await assert.rejects(f.bob.channel.receiveQueued(out.packet.record), /AUTHENTICATION_OR_REPLAY/);
  await assert.rejects(f.alice.channel.markDeliverySent(options.messageId), /UNAVAILABLE/);
  assert.deepEqual(f.bob.vault.read('signal-state').value.deliveryJournal, snapshot({ version: 1, outgoing: [], incoming: [] }));
});

test('journal: expiry during the asynchronous commit boundary releases nothing', async t => {
  for (const operation of ['list', 'redelivery', 'complete', 'sent']) {
    const f = await fixture(); t.after(() => f.close()); await f.connect(); const options = f.messageOptions();
    const out = await f.alice.channel.queueMessage(f.bobId, 'ack', {}, options);
    const incoming = await f.bob.channel.receiveQueued(out.packet.record);
    const attempts = { list: () => f.bob.channel.pendingMessages(f.aliceId), redelivery: () => f.bob.channel.receiveQueued(out.packet.record),
      complete: () => f.bob.channel.completeMessage(incoming.messageKey), sent: () => f.alice.channel.markDeliverySent(options.messageId) };
    const pending = attempts[operation](), rejected = assert.rejects(pending, /EXPIRED/);
    f.setNow(options.expiresAtMs); await rejected;
  }
});

test('journal: entry quota cannot silently discard live replay records or partially advance a ratchet', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  for (let i = 0; i < 64; i++) {
    await f.alice.channel.queueMessage(f.bobId, 'ack', {}, f.messageOptions('quota-' + i));
    await f.alice.channel.markDeliverySent('quota-' + i);
  }
  const before = f.alice.vault.read('signal-state');
  await assert.rejects(f.alice.channel.queueMessage(f.bobId, 'ack', {}, f.messageOptions('overflow')), /ENTRY_LIMIT/);
  assert.deepEqual(f.alice.vault.read('signal-state'), before);
  assert.equal((await f.alice.channel.queueMessage(f.bobId, 'ack', {}, f.messageOptions('quota-0'))).status, 'sent');
});

test('journal: encrypted storage byte quota preserves the last committed outbound state', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect(); let rejected = false;
  for (let i = 0; i < 64; i++) {
    const before = f.alice.vault.read('signal-state');
    try { await f.alice.channel.queueMessage(f.bobId, 'manifest', { data: 'x'.repeat(20_000) }, f.messageOptions('large-' + i)); }
    catch (error) { assert.match(error.message, /BYTE_LIMIT|SIZE_LIMIT/); assert.deepEqual(f.alice.vault.read('signal-state'), before); rejected = true; break; }
  }
  assert.equal(rejected, true);
});

test('journal: racing endpoint instances expose only one committed packet and the loser retries safely', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const second = new SignalParentChannel({ vault: f.alice.vault, scope, localRegistry: f.alice.registry, nowUnixMs: () => f.now });
  t.after(() => second.close()); f.authorize({ ...f.alice, channel: second }, f.bob);
  const options = f.messageOptions();
  const results = await Promise.allSettled([f.alice.channel.queueMessage(f.bobId, 'ack', {}, options), second.queueMessage(f.bobId, 'ack', {}, options)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /STATE_CONFLICT/);
  const winner = results.find(r => r.status === 'fulfilled').value;
  assert.deepEqual(await second.queueMessage(f.bobId, 'ack', {}, options), winner);
  assert.equal((await f.bob.channel.receiveQueued(winner.packet.record)).status, 'pending');
});

test('journal: signed control, encrypted payload and ratchet commit atomically and retry byte-identically', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const fields = { epoch: 1, sequence: 1, issuedAtMs: f.now, expiresAtMs: f.expiry(), action: 'lease' };
  const payload = { expiresAtMs: f.expiry(), stopAtMs: f.expiry(), fadeMs: 100, maxLinearGain: 0.5 };
  const packet = await f.alice.channel.queueControl(f.bobId, fields, payload, { messageId: 'lease-1' });
  assert.equal(packet.packet.recordType, 'control'); reopen(f, f.alice, f.bob);
  assert.deepEqual(await f.alice.channel.queueControl(f.bobId, fields, payload, { messageId: 'lease-1' }), packet);
  await assert.rejects(f.alice.channel.queueControl(f.bobId, { ...fields, sequence: 2 }, payload, { messageId: 'lease-1' }), /REQUEST_ID_CONFLICT/);
  const inbox = new SignalPlaybackInbox({ channel: f.bob.channel, sender: f.aliceId, nowUnixMs: () => f.now }); t.after(() => inbox.close());
  const verifier = await inbox.createVerifier(f.bob.vault);
  const body = await verifier.accept(packet.packet.record, f.now);
  assert.deepEqual(await inbox.decodeControlPayload(body), snapshot(payload));
  await assert.rejects(verifier.accept(packet.packet.record, f.now));
});

test('journal: failed signed-control commit returns no partial wire or signature', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const before = f.alice.vault.read('signal-state'), save = f.alice.vault.compareAndSet.bind(f.alice.vault);
  f.alice.vault.compareAndSet = () => false;
  await assert.rejects(f.alice.channel.queueControl(f.bobId,
    { epoch: 1, sequence: 1, issuedAtMs: f.now, expiresAtMs: f.expiry(), action: 'emergency-stop' }, {}, { messageId: 'stop' }), /STATE_CONFLICT/);
  assert.deepEqual(f.alice.vault.read('signal-state'), before); f.alice.vault.compareAndSet = save;
});
