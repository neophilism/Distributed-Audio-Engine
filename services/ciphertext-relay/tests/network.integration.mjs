import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageRendition, ProgramTimeline, compileProgram, EndpointPlaybackSession } from '../../../dist/src/index.js';
import { SignalPlaybackInbox, DurableSignalController, SignalRelayEndpoint, SignalParentChannel, EncryptedFileVault } from '../../../integrations/signal-parent/src/index.mjs';
import { fixture, scope } from '../../../integrations/signal-parent/tests/helpers.mjs';
import { KernelBridge } from '../../../integrations/signal-parent/tests/kernel-bridge.mjs';
import { relayFixture } from './helpers.mjs';

async function networkFixture(t, platform, { corruptAudio = false } = {}) {
  const f = await fixture(); t.after(() => f.close());
  // No f.connect(): recipient prekeys really traverse the TLS public directory.
  const relay = await relayFixture(t, { addresses: [f.aliceId, f.bobId, f.eve.descriptor.address], clock: () => f.now });
  const [sender, receiver] = relay.clients;
  await receiver.publishBundle(await f.bob.channel.publicBundle());
  const publicKeys = await sender.takeBundle(f.bobId); await f.alice.channel.connect(f.bobId, publicKeys);
  assert.equal(await sender.takeBundle(f.bobId), null);
  const context = { tenantId: scope.tenantId, application: scope.application, parentMessageId: 'network-parent' };
  const media = await packageRendition({ sampleRate: 8000, channels: 2, samples: Float32Array.from({ length: 48000 }, (_, i) => i % 2 ? -0.5 : 0.5) }, 1, context, 'private-name.wav');
  if (corruptAudio) media.ciphertextChunks[0][20] ^= 1;
  for (let i = 0; i < media.ciphertextChunks.length; i++) {
    await sender.uploadChunk({ tenantId: scope.tenantId, application: scope.application,
      storageObjectId: media.privateManifest.storageObjectId, chunkIndex: i, readers: [f.bobId], expiresAtMs: f.now + 30000,
      ciphertextBase64: Buffer.from(media.ciphertextChunks[i]).toString('base64') });
  }
  const descriptor = { assetId: 'asset', context, manifest: media.privateManifest, sampleRate: 8000, channels: 2, frames: 24000, authorizationValidUntilMs: f.now + 30000 };
  const record = await f.alice.channel.seal(f.bobId, 'manifest', descriptor, { messageId: context.parentMessageId, expiresAtMs: f.now + 30000 });
  const packet = { deliveryId: 'manifest-delivery', recordType: 'signal', record, expiresAtMs: f.now + 30000 };
  const receipt = await sender.send(f.bobId, packet);
  const inbox = new SignalPlaybackInbox({ channel: f.bob.channel, sender: f.aliceId, nowUnixMs: () => f.now });
  const [received] = await receiver.poll(); await inbox.acceptManifest(received.packet.record);
  await receiver.acknowledge([received.receiptId]); assert.equal((await sender.send(f.bobId, packet)).status, 'acknowledged');
  assert.equal(receipt.receiptId, received.receiptId);
  const initial = f.now, nativeNow = () => 5000 + f.now - initial;
  let allowed = true;
  const options = await inbox.sessionOptions({ vault: f.bob.vault, consentedGainCeiling: 0.75,
    timeline: new ProgramTimeline(f.now, compileProgram('program', 8000, [{ id: 'clip', assetId: 'asset', frames: 24000, markerAfter: null }])),
    transport: receiver.chunksFrom(f.aliceId, { application: scope.application, tenantId: scope.tenantId }),
    authorizePlayback: async () => allowed ? { allowed: true, validUntilMs: f.now + 30000 } : { allowed: false } });
  const bridge = new KernelBridge(nativeNow);
  const session = platform === 'android' ? EndpointPlaybackSession.android({ ...options, bridge, native: { nowMonotonicMs: nativeNow } })
    : EndpointPlaybackSession.ios({ ...options, bridge, native: { nowHostTimeMs: nativeNow } });
  bridge.activate(1);
  t.after(() => { session.close(); bridge.close(); inbox.close(); });
  const controller = new DurableSignalController({ vault: f.alice.vault, channel: f.alice.channel, nowUnixMs: () => f.now });
  t.after(() => controller.close());
  async function deliverControl(sequence, action = 'lease') {
    const delivery = await controller.issue({ operationId: 'control-' + sequence, recipient: f.bobId,
      action, expiresAtMs: f.now + 2000, payload: action === 'emergency-stop' ? null :
        { expiresAtMs: f.now + 500, stopAtMs: f.now + 500, fadeMs: 100, maxLinearGain: 0.5 } });
    assert.equal(delivery.packet.record.body.sequence, sequence);
    await sender.send(f.bobId, delivery.packet);
    const rows = await receiver.poll(); assert.equal(rows.length, 1);
    return rows[0];
  }
  return { f, relay, receiver, sender, bridge, session, deliverControl, nativeNow, descriptor, deny() { allowed = false; } };
}
for (const platform of ['android', 'ios']) {
  test(`${platform}: real HTTPS keys, private manifest, signed control and multi-chunk ciphertext reach C rendering`, async t => {
    const p = await networkFixture(t, platform); const row = await p.deliverControl(1);
    await p.session.join(row.packet.record); await p.receiver.acknowledge([row.receiptId]); await p.session.pump();
    assert.equal(p.relay.store.stats(p.f.now).chunks, 2);
    assert.ok(p.bridge.rawViews.every(view => view.every(sample => sample === 0)));
    const samples = p.bridge.render(p.nativeNow() + 50); assert.equal(samples[0], 0.25); assert.equal(samples[1], -0.25);
    assert.equal(p.bridge.render(p.nativeNow() + 450)[0], 0.125);
    assert.ok(p.bridge.render(p.nativeNow() + 500).every(n => n === 0));
  });
  test(`${platform}: valid TLS cannot make corrupted encrypted media become audible samples`, async t => {
    const p = await networkFixture(t, platform, { corruptAudio: true });
    await p.session.join((await p.deliverControl(1)).packet.record);
    await assert.rejects(p.session.pump()); assert.equal(p.bridge.samplesQueued, 0);
    assert.ok(p.bridge.render(p.nativeNow() + 50).every(n => n === 0));
  });
  test(`${platform}: network-delivered emergency clears native output and is not accepted twice`, async t => {
    const p = await networkFixture(t, platform); const first = await p.deliverControl(1);
    await p.session.join(first.packet.record); await p.receiver.acknowledge([first.receiptId]); await p.session.pump();
    const emergency = await p.deliverControl(2, 'emergency-stop'); await p.session.emergencyStop(emergency.packet.record);
    assert.equal(p.bridge.samplesQueued, 0); await assert.rejects(p.session.emergencyStop(emergency.packet.record));
  });
  test(`${platform}: endpoint revocation remains authoritative even when TLS relay credentials are still valid`, async t => {
    const p = await networkFixture(t, platform); await p.session.join((await p.deliverControl(1)).packet.record); await p.session.pump();
    await p.f.rotate(p.f.alice); await p.receiver.poll(); // Relay still has valid routing credentials.
    await assert.rejects(p.session.pump(), /IDENTITY_CHANGED/); assert.equal(p.bridge.samplesQueued, 0);
  });
}

for (const platform of ['android', 'ios']) {
  test(`${platform}: durable TLS intake survives two endpoint restarts; only a fresh lease restarts production C output`, async t => {
    const f = await fixture(); t.after(() => f.close());
    const relay = await relayFixture(t, { addresses: [f.aliceId, f.bobId], clock: () => f.now });
    const [sender, receiver] = relay.clients;
    await receiver.publishBundle(await f.bob.channel.publicBundle());
    await f.alice.channel.connect(f.bobId, await sender.takeBundle(f.bobId));
    const tx = new SignalRelayEndpoint({ channel: f.alice.channel, relay: sender, nowUnixMs: () => f.now });
    let rx, inbox, session, bridge;
    t.after(() => { tx.close(); rx?.close(); session?.close(); inbox?.close(); bridge?.close(); });
    const makeReceiver = () => new SignalRelayEndpoint({ channel: f.bob.channel, relay: receiver, nowUnixMs: () => f.now });
    rx = makeReceiver();
    const context = { tenantId: scope.tenantId, application: scope.application, parentMessageId: 'recover-manifest' };
    const media = await packageRendition({ sampleRate: 8000, channels: 2,
      samples: Float32Array.from({ length: 48000 }, (_, i) => i % 2 ? -0.5 : 0.5) }, 1, context, 'endpoint-only.wav');
    for (let i = 0; i < media.ciphertextChunks.length; i++) await sender.uploadChunk({ tenantId: scope.tenantId,
      application: scope.application, storageObjectId: media.privateManifest.storageObjectId, chunkIndex: i,
      readers: [f.bobId], expiresAtMs: f.now + 30000, ciphertextBase64: Buffer.from(media.ciphertextChunks[i]).toString('base64') });
    await f.alice.channel.queueMessage(f.bobId, 'manifest', { assetId: 'asset', context, manifest: media.privateManifest,
      sampleRate: 8000, channels: 2, frames: 24000, authorizationValidUntilMs: f.now + 30000 },
      { messageId: context.parentMessageId, expiresAtMs: f.now + 30000 });
    await tx.flush(f.bobId); await rx.pull(); assert.equal((await receiver.poll()).length, 0);
    const initial = f.now, nativeNow = () => 5000 + f.now - initial;
    const timeline = new ProgramTimeline(initial, compileProgram('recovered', 8000,
      [{ id: 'clip', assetId: 'asset', frames: 24000, markerAfter: null }]));
    async function restart() {
      session?.close(); inbox?.close(); bridge?.close(); rx.close();
      const minimumRevision = f.bob.vault.revision; f.bob.channel.close(); f.bob.vault.close();
      f.bob.vault = new EncryptedFileVault({ ...f.bob.options, minimumRevision });
      f.bob.channel = new SignalParentChannel({ vault: f.bob.vault, scope, localRegistry: f.bob.registry, nowUnixMs: () => f.now });
      f.authorize(f.bob, f.alice); rx = makeReceiver();
      inbox = new SignalPlaybackInbox({ channel: f.bob.channel, sender: f.aliceId, nowUnixMs: () => f.now,
        durable: true, vault: f.bob.vault });
      assert.equal((await inbox.restoreManifests()).length, 1);
      const options = await inbox.sessionOptions({ vault: f.bob.vault, timeline, consentedGainCeiling: 0.75,
        transport: receiver.chunksFrom(f.aliceId, { application: scope.application, tenantId: scope.tenantId }),
        authorizePlayback: async () => ({ allowed: true, validUntilMs: f.now + 30000 }) });
      bridge = new KernelBridge(nativeNow);
      session = platform === 'android' ? EndpointPlaybackSession.android({ ...options, bridge, native: { nowMonotonicMs: nativeNow } })
        : EndpointPlaybackSession.ios({ ...options, bridge, native: { nowHostTimeMs: nativeNow } });
      assert.equal(session.snapshot().phase, 'idle');
      bridge.activate(1);
      assert.equal(session.snapshot().phase, 'stopped');
      assert.equal(session.snapshot().stopReason, 'output-changed');
      assert.equal(bridge.samplesQueued, 0);
      assert.ok(bridge.render(nativeNow()).every(value => value === 0));
    }
    async function lease(sequence) {
      await f.alice.channel.queueControl(f.bobId,
        { epoch: 1, sequence, issuedAtMs: f.now, expiresAtMs: f.now + 2000, action: 'lease' },
        { expiresAtMs: f.now + 500, stopAtMs: f.now + 500, fadeMs: 100, maxLinearGain: 0.5 }, { messageId: 'recovery-lease-' + sequence });
      await tx.flush(f.bobId); const [message] = await rx.pull(); return message;
    }
    // Crash after relay acknowledgment, before any private manifest was installed.
    await restart(); assert.equal(f.bob.vault.read('control-checkpoints'), undefined);
    const first = await lease(1); assert.equal(f.bob.vault.read('control-checkpoints'), undefined);
    await session.join(first.packet.record); await session.pump();
    assert.equal(bridge.render(nativeNow() + 50)[0], 0.25);
    await f.bob.channel.completeMessage(first.messageKey);
    // A persisted playback checkpoint cannot be reset by cryptographic recovery.
    f.setNow(f.now + 1); await restart();
    await assert.rejects(session.join(first.packet.record), /REPLAY_OR_GAP/);
    assert.equal(bridge.samplesQueued, 0);
    const fresh = await lease(2); await session.join(fresh.packet.record); await session.pump();
    assert.equal(bridge.render(nativeNow() + 50)[0], 0.25);
    assert.ok(bridge.render(nativeNow() + 500).every(value => value === 0));
    assert.ok(bridge.rawViews.every(view => view.every(sample => sample === 0)));
    assert.equal((await receiver.poll()).length, 0);
  });
}
