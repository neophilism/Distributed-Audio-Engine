import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisciplinedClock } from '../../../dist/src/index.js';
import { fixture, scope } from './helpers.mjs';
import { DurableSignalController, SignalPlaybackInbox, queueSignalClockProbe,
  respondSignalClockProbe } from '../src/index.mjs';

async function harness(t) {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const issuer = new DurableSignalController({ vault: f.bob.vault, channel: f.bob.channel, nowUnixMs: () => f.now });
  t.after(() => issuer.close());
  const inbox = new SignalPlaybackInbox({ channel: f.alice.channel, sender: f.bobId,
    nowUnixMs: () => f.now, durable: true, vault: f.alice.vault });
  t.after(() => inbox.close());
  let mono = 0;
  const verifier = await inbox.createClockVerifier(f.alice.vault);
  const clock = new DisciplinedClock(scope, verifier, inbox.decodeControlPayload,
    () => mono, { minSamples: 1 });
  const request = await queueSignalClockProbe({ channel: f.alice.channel, recipient: f.bobId,
    clock, messageId: 'probe-1', expiresAtMs: f.now + 3000 });
  const receipt = await f.bob.channel.receivePacket(request.delivery.packet, f.aliceId);
  assert.equal(receipt.status, 'pending');
  assert.equal(receipt.kind, 'ack');
  return { f, issuer, inbox, verifier, clock, request, receipt, setMono: value => { mono = value; } };
}

test('authenticated end-to-end Signal clock probe travels both ways without exposing challenge at the relay', async t => {
  const p = await harness(t);
  assert.equal(JSON.stringify(p.request.delivery.packet).includes(p.request.probe.nonce), false);
  const reply = await respondSignalClockProbe({ channel: p.f.bob.channel,
    controller: p.issuer, receipt: p.receipt, receivedUnixMs: p.f.now,
    uncertaintyMs: 1, nowUnixMs: () => p.f.now });
  assert.equal(reply.reused, false);
  assert.equal(reply.delivery.packet.recordType, 'control');
  assert.equal(JSON.stringify(reply.delivery.packet).includes(p.request.probe.nonce), false);
  await p.f.alice.channel.receivePacket(reply.delivery.packet, p.f.bobId);
  p.setMono(20);
  await p.clock.accept(reply.delivery.packet.record, p.f.now);
  const estimated = p.clock.estimate();
  assert.equal(estimated.state, 'usable');
  assert.equal(estimated.assurance, 'network-clock-only');
  assert.ok(estimated.lowerUnixMs <= p.f.now && estimated.upperUnixMs >= p.f.now);
  assert.equal(p.f.alice.vault.read('control-checkpoints').value[0].sequence, 1);
});

test('replayed durable probe reuses byte-identical encrypted response and leaves the sequence unchanged', async t => {
  const p = await harness(t);
  const inputs = { channel: p.f.bob.channel, controller: p.issuer, receipt: p.receipt,
    receivedUnixMs: p.f.now, uncertaintyMs: 1, nowUnixMs: () => p.f.now };
  const first = await respondSignalClockProbe(inputs);
  const repeated = await respondSignalClockProbe(inputs);
  assert.equal(repeated.reused, true);
  assert.deepEqual(repeated.delivery, first.delivery);
  assert.equal(p.issuer.streamState(p.f.aliceId).sequence, 1);
  assert.equal((await p.f.bob.channel.pendingDeliveries(p.f.aliceId)).length, 1);
});

test('forged or edited clock-probe receipts cannot trigger a signed clock response', async t => {
  const p = await harness(t);
  const input = { channel: p.f.bob.channel, controller: p.issuer,
    receivedUnixMs: p.f.now, uncertaintyMs: 1, nowUnixMs: () => p.f.now };
  const forged = structuredClone(p.receipt);
  forged.message.payload.nonce = 'f'.repeat(64);
  await assert.rejects(respondSignalClockProbe({ ...input, receipt: forged }), /NOT_AUTHENTICATED/);
  await assert.rejects(respondSignalClockProbe({ ...input, receipt: p.receipt,
    uncertaintyMs: -1 }), /UNCERTAINTY/);
  assert.deepEqual(p.issuer.pending(), []);
  assert.equal(p.issuer.streamState(p.f.aliceId).sequence, 0);
});

test('membership revocation, stale reference samples and completed receipts are rejected before new issuance', async t => {
  const p = await harness(t);
  await assert.rejects(respondSignalClockProbe({ channel: p.f.bob.channel,
    controller: p.issuer, receipt: p.receipt, receivedUnixMs: p.f.now - 6000,
    uncertaintyMs: 1, nowUnixMs: () => p.f.now }), /SAMPLE_TIME/);
  await p.f.bob.channel.completeMessage(p.receipt.messageKey);
  await assert.rejects(respondSignalClockProbe({ channel: p.f.bob.channel,
    controller: p.issuer, receipt: p.receipt, receivedUnixMs: p.f.now,
    uncertaintyMs: 1, nowUnixMs: () => p.f.now }), /NOT_AUTHENTICATED/);
  await p.f.rotate(p.f.alice);
  await assert.rejects(respondSignalClockProbe({ channel: p.f.bob.channel,
    controller: p.issuer, receipt: p.receipt, receivedUnixMs: p.f.now,
    uncertaintyMs: 1, nowUnixMs: () => p.f.now }), /IDENTITY_CHANGED/);
  assert.equal(p.issuer.streamState(p.f.aliceId).sequence, 0);
});
