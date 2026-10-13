import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signControl, packageRendition } from '../../../dist/src/index.js';
import { SignalPlaybackInbox, SignalRelayEndpoint, SignalParentChannel, EncryptedFileVault } from '../src/index.mjs';
import { snapshot } from '../src/validation.mjs';
import { fixture, scope } from './helpers.mjs';

const relayId = 'f'.repeat(64);
const state = f => f.bob.vault.read('signal-state');
function reopen(f, who, peer) {
  const minimumRevision = who.vault.revision; who.channel.close(); who.vault.close();
  who.vault = new EncryptedFileVault({ ...who.options, minimumRevision });
  who.channel = new SignalParentChannel({ vault: who.vault, scope, localRegistry: who.registry, nowUnixMs: () => f.now });
  f.authorize(who, peer);
}
const control = (f, id = 'lease', sequence = 1) => f.alice.channel.queueControl(f.bobId,
  { epoch: 1, sequence, issuedAtMs: f.now, expiresAtMs: f.expiry(), action: 'lease' },
  { expiresAtMs: f.expiry(), stopAtMs: f.expiry(), fadeMs: 100, maxLinearGain: 0.5 }, { messageId: id });
function mockRelay(rows = []) {
  const result = { rows, sends: [], acknowledgments: [],
    async send(recipient, packet) { this.sends.push(snapshot({ recipient, packet })); return { receiptId: relayId, status: 'stored' }; },
    async poll() { return snapshot(this.rows); },
    async acknowledge(ids) { this.acknowledgments.push(...ids); this.rows = this.rows.filter(row => !ids.includes(row.receiptId)); } };
  return result;
}
function endpoint(f, relay, who = f.bob) { return new SignalRelayEndpoint({ channel: who.channel, relay, nowUnixMs: () => f.now }); }
async function manifest(f, id, assetId = 'asset', authorizationValidUntilMs = f.expiry(), expiresAtMs = f.expiry()) {
  const context = { tenantId: scope.tenantId, application: scope.application, parentMessageId: id };
  const media = await packageRendition({ sampleRate: 8000, channels: 1, samples: new Float32Array(8000) }, 1, context, 'private.wav');
  const descriptor = { assetId, context, manifest: media.privateManifest, sampleRate: 8000, channels: 1, frames: 8000, authorizationValidUntilMs };
  const queued = await f.alice.channel.queueMessage(f.bobId, 'manifest', descriptor, { messageId: id, expiresAtMs });
  return { ...queued, descriptor };
}
function inbox(f) { return new SignalPlaybackInbox({ channel: f.bob.channel, sender: f.aliceId, nowUnixMs: () => f.now, durable: true, vault: f.bob.vault }); }

test('packet intake preserves the signed ciphertext and envelope across restart without consuming execution authority', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const queued = await control(f), received = await f.bob.channel.receivePacket(queued.packet, f.aliceId);
  assert.deepEqual(received.packet, queued.packet); assert.equal(f.bob.vault.read('control-checkpoints'), undefined);
  reopen(f, f.bob, f.alice);
  const [restored] = await f.bob.channel.pendingMessages(f.aliceId); assert.deepEqual(restored, received);
  const playback = inbox(f); t.after(() => playback.close());
  const verifier = await playback.createVerifier(f.bob.vault), body = await verifier.accept(restored.packet.record, f.now);
  const before = state(f).value.sessions;
  assert.equal((await playback.decodeControlPayload(body)).maxLinearGain, 0.5);
  assert.deepEqual(state(f).value.sessions, before);
  await assert.rejects(verifier.accept(restored.packet.record, f.now), /REPLAY_OR_GAP/);
  const done = await f.bob.channel.completeMessage(restored.messageKey);
  assert.equal('packet' in done, false); assert.equal('message' in done, false);
  assert.deepEqual(await f.bob.channel.receivePacket(queued.packet, f.aliceId), done);
});

test('packet intake rejects forged signature, inner header, routing and envelope bindings without committing the ratchet', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect(); const { packet } = await control(f), before = state(f);
  const badSignature = structuredClone(packet); badSignature.record.signatureHex = '0'.repeat(128);
  const badHeader = structuredClone(packet);
  badHeader.record = await signControl({ ...badHeader.record.body, sequence: 2 }, await f.alice.channel.localControlKey());
  for (const [copy, sender] of [[badSignature, f.aliceId], [badHeader, f.aliceId], [packet, f.eve.descriptor.address],
    [{ ...packet, deliveryId: 'different' }, f.aliceId], [{ ...packet, expiresAtMs: packet.expiresAtMs - 1 }, f.aliceId]]) {
    await assert.rejects(f.bob.channel.receivePacket(copy, sender)); assert.deepEqual(state(f), before);
  }
  await f.bob.channel.receivePacket(packet, f.aliceId);
  await assert.rejects(f.bob.channel.receivePacket({ ...packet, deliveryId: 'different' }, f.aliceId), /PACKET_CONFLICT/);
});

test('unsigned generic control packets cannot enter the signed-control recovery path', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const queued = await f.alice.channel.queueMessage(f.bobId, 'control', {}, f.messageOptions()); const before = state(f);
  await assert.rejects(f.bob.channel.receivePacket(queued.packet, f.aliceId), /SIGNATURE_REQUIRED/); assert.deepEqual(state(f), before);
});

test('relay flush recovers a lost send response with the identical saved packet', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const queued = await f.alice.channel.queueMessage(f.bobId, 'ack', {}, f.messageOptions());
  const relay = mockRelay(), pump = endpoint(f, relay, f.alice); t.after(() => pump.close());
  const send = relay.send.bind(relay); let fail = true;
  relay.send = async (...args) => { const result = await send(...args); if (fail) { fail = false; throw Error('lost-send-response'); } return result; };
  await assert.rejects(pump.flush(f.bobId), /lost-send-response/);
  assert.deepEqual(await f.alice.channel.pendingDeliveries(f.bobId), [queued]);
  assert.deepEqual(await pump.flush(f.bobId), { sent: 1 }); assert.equal(relay.sends.length, 2);
  assert.deepEqual(relay.sends[0], relay.sends[1]); assert.deepEqual(await f.alice.channel.pendingDeliveries(f.bobId), []);
});

test('relay pull does not acknowledge failed persistence and acknowledges only after a recoverable commit', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect(); const queued = await control(f);
  const relay = mockRelay([{ receiptId: relayId, sender: f.aliceId, packet: queued.packet }]), pump = endpoint(f, relay); t.after(() => pump.close());
  const save = f.bob.vault.compareAndSet.bind(f.bob.vault); f.bob.vault.compareAndSet = () => false;
  await assert.rejects(pump.pull(), /STATE_CONFLICT/); assert.deepEqual(relay.acknowledgments, []);
  f.bob.vault.compareAndSet = save;
  const ack = relay.acknowledge.bind(relay);
  relay.acknowledge = async (...args) => {
    assert.equal(state(f).value.deliveryJournal.incoming.length, 1);
    assert.equal(f.bob.vault.read('control-checkpoints'), undefined);
    return ack(...args);
  };
  const [received] = await pump.pull(); assert.deepEqual(received.packet, queued.packet);
  assert.deepEqual(relay.acknowledgments, [relayId]);
});

test('lost acknowledgment and lost result preserve a recoverable authenticated command', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect(); const queued = await control(f);
  const relay = mockRelay([{ receiptId: relayId, sender: f.aliceId, packet: queued.packet }]), pump = endpoint(f, relay); t.after(() => pump.close());
  const ack = relay.acknowledge.bind(relay); relay.acknowledge = async (...args) => { await ack(...args); throw Error('lost-ack-response'); };
  await assert.rejects(pump.pull(), /lost-ack-response/); assert.equal(relay.rows.length, 0);
  reopen(f, f.bob, f.alice);
  const [pending] = await f.bob.channel.pendingMessages(f.aliceId); assert.deepEqual(pending.packet, queued.packet);
  assert.equal(f.bob.vault.read('control-checkpoints'), undefined);
});

test('relay redelivery of completed work returns only a tombstone and can be acknowledged again', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const queued = await f.alice.channel.queueMessage(f.bobId, 'ack', {}, f.messageOptions());
  const row = { receiptId: relayId, sender: f.aliceId, packet: queued.packet }, relay = mockRelay([row]), pump = endpoint(f, relay); t.after(() => pump.close());
  const [first] = await pump.pull(); await f.bob.channel.completeMessage(first.messageKey); relay.rows = [row];
  const [second] = await pump.pull(); assert.equal(second.status, 'completed'); assert.equal('message' in second, false);
  assert.equal(relay.acknowledgments.length, 2);
});

test('relay wrapper bounds batches, rejects overlapping work and withholds late results after close', async t => {
  const f = await fixture(); t.after(() => f.close()); const relay = mockRelay(Array(9).fill({})), pump = endpoint(f, relay); t.after(() => pump.close());
  await assert.rejects(pump.pull(), /BATCH_LIMIT/); assert.deepEqual(relay.acknowledgments, []);
  let release; relay.poll = () => new Promise(resolve => { release = resolve; });
  const pending = pump.pull(), rejected = assert.rejects(pending, /CLOSED|ABORTED/);
  await assert.rejects(pump.pull(), /BUSY/); pump.close(); release([]); await rejected;
});

test('relay wrapper does not transmit aborted work and rechecks membership after a send', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  await f.alice.channel.queueMessage(f.bobId, 'ack', {}, f.messageOptions());
  const relay = mockRelay(), pump = endpoint(f, relay, f.alice); t.after(() => pump.close());
  const abort = new AbortController(); abort.abort(); await assert.rejects(pump.flush(f.bobId, abort.signal), /ABORTED/);
  assert.equal(relay.sends.length, 0);
  relay.send = async () => { await f.rotate(f.bob); return { receiptId: relayId, status: 'stored' }; };
  await assert.rejects(pump.flush(f.bobId), /IDENTITY_CHANGED/);
  assert.equal(f.alice.vault.read('signal-state').value.deliveryJournal.outgoing[0].status, 'pending');
});

test('durable manifest restoration revalidates private context and returns keys only to a currently authorized endpoint', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect(); const queued = await manifest(f, 'private-manifest');
  await f.bob.channel.receivePacket(queued.packet, f.aliceId); reopen(f, f.bob, f.alice);
  const playback = inbox(f); t.after(() => playback.close());
  assert.deepEqual(await playback.restoreManifests(), [{ assetId: 'asset', expiresAtMs: queued.descriptor.authorizationValidUntilMs }]);
  const restored = await playback.resolver.resolve('asset', scope, new AbortController().signal);
  assert.equal(restored.manifest.attachmentKeyHex, queued.descriptor.manifest.attachmentKeyHex);
  assert.equal(f.bob.vault.read('control-checkpoints'), undefined);
  await f.rotate(f.alice); await assert.rejects(playback.restoreManifests(), /IDENTITY_CHANGED/);
  await assert.rejects(playback.resolver.resolve('asset', scope, new AbortController().signal), /IDENTITY_CHANGED/);
});

test('durable manifest heads prevent an expired replacement from resurrecting an older retained asset key', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect(); let playback = inbox(f); t.after(() => playback.close());
  const old = await manifest(f, 'old', 'asset', f.now + 20000, f.now + 20000); await playback.acceptManifest(old.packet.record);
  f.setNow(f.now + 1);
  const newer = await manifest(f, 'new', 'asset', f.now + 100, f.now + 100); await playback.acceptManifest(newer.packet.record);
  playback.close(); f.setNow(f.now + 101); reopen(f, f.bob, f.alice); playback = inbox(f);
  await assert.rejects(playback.restoreManifests(), /MANIFEST_ROLLBACK/);
  await assert.rejects(playback.resolver.resolve('asset', scope, new AbortController().signal), /UNAVAILABLE/);
  const fresh = await manifest(f, 'fresh'); await playback.acceptManifest(fresh.packet.record);
  assert.equal((await playback.resolver.resolve('asset', scope, new AbortController().signal)).context.parentMessageId, 'fresh');
});

test('durable mode requires its encrypted application store and a failed manifest-head commit releases no cached key', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  assert.throws(() => new SignalPlaybackInbox({ channel: f.bob.channel, sender: f.aliceId, nowUnixMs: () => f.now, durable: true }), /VAULT_REQUIRED/);
  const playback = inbox(f); t.after(() => playback.close()); const queued = await manifest(f, 'pending');
  await f.bob.channel.receivePacket(queued.packet, f.aliceId);
  const save = f.bob.vault.compareAndSet.bind(f.bob.vault);
  f.bob.vault.compareAndSet = (name, ...args) => name.startsWith('manifest-heads-') ? false : save(name, ...args);
  await assert.rejects(playback.restoreManifests(), /HEAD_CONFLICT/);
  await assert.rejects(playback.resolver.resolve('asset', scope, new AbortController().signal), /UNAVAILABLE/);
  f.bob.vault.compareAndSet = save; assert.equal((await playback.restoreManifests()).length, 1);
});
