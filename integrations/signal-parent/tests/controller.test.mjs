import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, scope } from './helpers.mjs';
import { DurableSignalController, EncryptedFileVault, SignalParentChannel, SignalPlaybackInbox } from '../src/index.mjs';

function make(f) { return new DurableSignalController({ vault: f.alice.vault, channel: f.alice.channel, nowUnixMs: () => f.now }); }
function request(f, operationId = 'controller-lease') {
  return { operationId, recipient: f.bobId, action: 'lease', expiresAtMs: f.now + 5000,
    payload: { expiresAtMs: f.now + 3000, stopAtMs: f.now + 3000, fadeMs: 100, maxLinearGain: 0.25 } };
}
function reopen(f) {
  const minimumRevision = f.alice.vault.revision; f.alice.channel.close(); f.alice.vault.close();
  f.alice.vault = new EncryptedFileVault({ ...f.alice.options, minimumRevision });
  f.alice.channel = new SignalParentChannel({ vault: f.alice.vault, scope, localRegistry: f.alice.registry, nowUnixMs: () => f.now });
  f.authorize(f.alice, f.bob);
}

test('controller: actual Signal messages and signed playback checkpoints use durably allocated sequence numbers', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const controller = make(f); t.after(() => controller.close());
  const inbox = new SignalPlaybackInbox({ channel: f.bob.channel, sender: f.aliceId, nowUnixMs: () => f.now,
    durable: true, vault: f.bob.vault }); t.after(() => inbox.close());
  const verifier = await inbox.createVerifier(f.bob.vault);
  const lease = request(f), first = await controller.issue(lease);
  await f.bob.channel.receivePacket(first.packet, f.aliceId);
  const body = await verifier.accept(first.packet.record, f.now);
  assert.equal(body.sequence, 1); assert.equal(body.epoch, 1);
  assert.deepEqual({ ...await inbox.decodeControlPayload(body) }, lease.payload);
  const emergency = await controller.issue({ operationId: 'controller-emergency', recipient: f.bobId,
    action: 'emergency-stop', payload: null, expiresAtMs: f.now + 5000 });
  await f.bob.channel.receivePacket(emergency.packet, f.aliceId);
  assert.equal((await verifier.accept(emergency.packet.record, f.now)).sequence, 2);
  await assert.rejects(verifier.accept(first.packet.record, f.now), /REPLAY_OR_GAP/);
  assert.equal(readFileSync(join(f.alice.options.directory, 'signal.vault')).includes(Buffer.from('maxLinearGain')), false);
});
test('controller: real encrypted endpoint reopen returns identical ratchet ciphertext without duplicating a command', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  let controller = make(f); t.after(() => controller.close());
  const first = await controller.issue(request(f)); controller.close(); f.setNow(f.now + 1); reopen(f); controller = make(f);
  const retried = await controller.resume('controller-lease'); assert.deepEqual(retried, first);
  assert.equal((await f.alice.channel.pendingDeliveries(f.bobId)).length, 1);
  const second = await controller.issue(request(f, 'next-lease'));
  assert.equal(second.packet.record.body.sequence, 2);
  await f.bob.channel.receivePacket(first.packet, f.aliceId);
  await f.bob.channel.receivePacket(second.packet, f.aliceId);
});
test('controller: actual ratchet commit followed by failed completion is recoverable across sender restart', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  let controller = make(f); t.after(() => controller.close());
  const write = f.alice.vault.compareAndSet.bind(f.alice.vault);
  f.alice.vault.compareAndSet = (name, revision, value) => {
    if (name === 'controller-state' && value.operations.some(o => o.status === 'queued')) throw Error('COMPLETION_STORAGE_FAILED');
    return write(name, revision, value);
  };
  await assert.rejects(controller.issue(request(f)), /COMPLETION_STORAGE_FAILED/);
  const [retained] = await f.alice.channel.pendingDeliveries(f.bobId); assert.ok(retained);
  controller.close(); reopen(f); controller = make(f);
  assert.equal(controller.pending().length, 1);
  assert.deepEqual(await controller.resume('controller-lease'), retained);
  assert.deepEqual(controller.pending(), []);
  const received = await f.bob.channel.receivePacket(retained.packet, f.aliceId);
  assert.equal(received.messageId, 'controller-lease');
});
test('controller: explicit higher epoch reconciles uncertainty and old signed authority remains rejected', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const controller = make(f); t.after(() => controller.close()); const old = await controller.issue(request(f));
  controller.advanceEpoch(f.bobId, 1);
  const fresh = await controller.issue(request(f, 'fresh-lease'));
  assert.equal(fresh.packet.record.body.epoch, 2); assert.equal(fresh.packet.record.body.sequence, 1);
  const inbox = new SignalPlaybackInbox({ channel: f.bob.channel, sender: f.aliceId, nowUnixMs: () => f.now,
    durable: true, vault: f.bob.vault }); t.after(() => inbox.close());
  const verifier = await inbox.createVerifier(f.bob.vault);
  await f.bob.channel.receivePacket(fresh.packet, f.aliceId); await verifier.accept(fresh.packet.record, f.now);
  await assert.rejects(verifier.accept(old.packet.record, f.now), /EPOCH_ROLLBACK/);
  await assert.rejects(controller.resume('controller-lease'), /EPOCH_SUPERSEDED/);
});
test('controller: rotated endpoints cannot replay stored intents even while packets remain on disk', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const controller = make(f); t.after(() => controller.close()); await controller.issue(request(f));
  const before = f.alice.vault.read('signal-state'); await f.rotate(f.bob);
  await assert.rejects(controller.resume('controller-lease'), /IDENTITY_CHANGED/);
  assert.deepEqual(f.alice.vault.read('signal-state'), before);
  assert.throws(() => controller.advanceEpoch(f.bobId, 1), /IDENTITY_CHANGED/);
});
