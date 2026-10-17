import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisciplinedClock } from '../../../dist/src/index.js';
import { fixture, scope } from './helpers.mjs';
import { DurableSignalController, SignalPlaybackInbox } from '../src/index.mjs';

const makeController = f => new DurableSignalController({
  vault: f.alice.vault, channel: f.alice.channel, nowUnixMs: () => f.now,
});
const makeInbox = f => new SignalPlaybackInbox({
  channel: f.bob.channel, sender: f.aliceId, nowUnixMs: () => f.now,
  durable: true, vault: f.bob.vault,
});
function response(f, nonce) {
  return { nonce, receivedUnixMs: f.now - 12, sentUnixMs: f.now - 8, uncertaintyMs: 0.1 };
}
function request(f, operationId, nonce) {
  return { operationId, recipient: f.bobId, action: 'clock-response',
    expiresAtMs: f.now + 3000, payload: response(f, nonce) };
}

test('actual Signal ciphertext carries a durable signed clock response into the disciplined receiver clock', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const controller = makeController(f); t.after(() => controller.close());
  const inbox = makeInbox(f); t.after(() => inbox.close());
  const verifier = await inbox.createClockVerifier(f.bob.vault);
  let monotonicMs = 0;
  const clock = new DisciplinedClock(scope, verifier, inbox.decodeControlPayload,
    () => monotonicMs, { minSamples: 1 });
  const probe = clock.beginProbe();
  monotonicMs = 20;
  const outbound = await controller.issue(request(f, 'clock-operation-1', probe.nonce));
  assert.equal(outbound.packet.recordType, 'control');
  assert.equal(outbound.packet.record.body.action, 'clock-response');
  assert.equal(JSON.stringify(outbound.packet).includes(probe.nonce), false);
  const retained = await f.bob.channel.receivePacket(outbound.packet, f.aliceId);
  assert.equal(retained.kind, 'control');
  await clock.accept(outbound.packet.record, f.now);
  const estimate = clock.estimate();
  assert.equal(estimate.state, 'usable');
  assert.equal(estimate.assurance, 'network-clock-only');
  assert.ok(estimate.lowerUnixMs <= f.now && estimate.upperUnixMs >= f.now);
  assert.ok(Math.abs(clock.nowUnixMs(50) - f.now) <= 1);
  assert.deepEqual(await controller.resume('clock-operation-1'), outbound);
  await assert.rejects(verifier.accept(outbound.packet.record, f.now), /REPLAY_OR_GAP/);
  assert.equal(f.bob.vault.read('control-checkpoints').value[0].sequence, 1);
});

test('clock and playback controls consume one durable strict-sequence checkpoint', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const controller = makeController(f); t.after(() => controller.close());
  const inbox = makeInbox(f); t.after(() => inbox.close());
  const verifier = await inbox.createClockVerifier(f.bob.vault);
  let monotonicMs = 0;
  const clock = new DisciplinedClock(scope, verifier, inbox.decodeControlPayload,
    () => monotonicMs, { minSamples: 1 });
  const probe = clock.beginProbe(); monotonicMs = 20;
  const clockPacket = (await controller.issue(request(f, 'clock-then-lease', probe.nonce))).packet;
  await f.bob.channel.receivePacket(clockPacket, f.aliceId);
  await clock.accept(clockPacket.record, f.now);
  const lease = await controller.issue({ operationId: 'lease-after-clock', recipient: f.bobId,
    action: 'lease', expiresAtMs: f.now + 4000,
    payload: { expiresAtMs: f.now + 3000, stopAtMs: f.now + 3000, fadeMs: 100, maxLinearGain: 0.25 } });
  await f.bob.channel.receivePacket(lease.packet, f.aliceId);
  const playbackVerifier = await inbox.createVerifier(f.bob.vault);
  assert.equal((await playbackVerifier.accept(lease.packet.record, f.now)).sequence, 2);
  assert.deepEqual({ ...await inbox.decodeControlPayload(lease.packet.record.body) }, {
    expiresAtMs: f.now + 3000, stopAtMs: f.now + 3000, fadeMs: 100, maxLinearGain: 0.25,
  });
  await assert.rejects(playbackVerifier.accept(clockPacket.record, f.now), /ACTION_NOT_AUTHORIZED/);
});

test('bad clock responses fail before an encrypted controller reservation or queued packet', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const controller = makeController(f); t.after(() => controller.close());
  const valid = request(f, 'bad-clock', 'a'.repeat(64));
  for (const payload of [
    { ...valid.payload, nonce: 'invalid' },
    { ...valid.payload, sentUnixMs: f.now + 1 },
    { ...valid.payload, receivedUnixMs: f.now - 10_000 },
    { ...valid.payload, uncertaintyMs: Number.POSITIVE_INFINITY },
    { ...valid.payload, uncertaintyMs: 1001 },
    { ...valid.payload, ignored: 1 },
  ]) {
    await assert.rejects(controller.issue({ ...valid, payload }));
    assert.deepEqual(controller.pending(), []);
    assert.deepEqual(await f.alice.channel.pendingDeliveries(f.bobId), []);
  }
  await assert.rejects(controller.issue({ ...valid, expiresAtMs: f.now + 5001 }));
  await assert.rejects(f.alice.channel.queueControl(f.bobId, {
    epoch: 1, sequence: 1, issuedAtMs: f.now, expiresAtMs: f.now + 3000, action: 'clock-response',
  }, { ...valid.payload, nonce: 'x' }, { messageId: 'invalid-direct-clock' }), /PARENT_CLOCK_NONCE/);
  assert.deepEqual(await f.alice.channel.pendingDeliveries(f.bobId), []);
});

test('a root-revoked clock signer cannot consume the receiver replay checkpoint', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const controller = makeController(f); t.after(() => controller.close());
  const inbox = makeInbox(f); t.after(() => inbox.close());
  const verifier = await inbox.createClockVerifier(f.bob.vault);
  const issued = await controller.issue(request(f, 'revoked-clock', 'a'.repeat(64)));
  await f.rotate(f.alice);
  await assert.rejects(verifier.accept(issued.packet.record, f.now), /IDENTITY_CHANGED/);
  assert.equal(f.bob.vault.read('control-checkpoints'), undefined);
});
