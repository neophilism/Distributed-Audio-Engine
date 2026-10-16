import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageNormalizedRendition, ProgramTimeline, compileProgram, EndpointPlaybackSession } from '../../../dist/src/index.js';
import { SignalPlaybackInbox, DurableSignalController, SignalRelayEndpoint } from '../../../integrations/signal-parent/src/index.mjs';
import { fixture, scope } from '../../../integrations/signal-parent/tests/helpers.mjs';
import { KernelBridge } from '../../../integrations/signal-parent/tests/kernel-bridge.mjs';
import { relayFixture } from './helpers.mjs';

// Real Signal, real TLS, persistent endpoint intake and actual C rendering.
// The output routes and clocks remain synthetic; no physical phone is claimed.
for (const platform of ['android', 'ios']) {
  test(`${platform}: normalized source format traverses actual Signal, TLS and the production C renderer`, async t => {
    const f = await fixture(); t.after(() => f.close());
    const relay = await relayFixture(t, { addresses: [f.aliceId, f.bobId], clock: () => f.now });
    const [sender, receiver] = relay.clients;
    await receiver.publishBundle(await f.bob.channel.publicBundle());
    await f.alice.channel.connect(f.bobId, await sender.takeBundle(f.bobId));
    const context = { tenantId: scope.tenantId, application: scope.application, parentMessageId: 'normalized-parent' };
    const media = await packageNormalizedRendition(
      { sampleRate: 44100, channels: 1, samples: new Float32Array(132300).fill(0.5) },
      { sampleRate: 8000, channels: 2 }, 1, context, 'normalized.wav');
    assert.equal(media.privateMetadata.frames, 24000); assert.equal(media.privateMetadata.channels, 2);
    for (let i = 0; i < media.ciphertextChunks.length; i++) await sender.uploadChunk({ tenantId: scope.tenantId,
      application: scope.application, storageObjectId: media.privateManifest.storageObjectId, chunkIndex: i,
      readers: [f.bobId], expiresAtMs: f.now + 30000, ciphertextBase64: Buffer.from(media.ciphertextChunks[i]).toString('base64') });
    const tx = new SignalRelayEndpoint({ channel: f.alice.channel, relay: sender, nowUnixMs: () => f.now });
    const rx = new SignalRelayEndpoint({ channel: f.bob.channel, relay: receiver, nowUnixMs: () => f.now });
    const controller = new DurableSignalController({ vault: f.alice.vault, channel: f.alice.channel, nowUnixMs: () => f.now });
    const inbox = new SignalPlaybackInbox({ channel: f.bob.channel, sender: f.aliceId, nowUnixMs: () => f.now,
      durable: true, vault: f.bob.vault });
    let bridge, session;
    t.after(() => { session?.close(); bridge?.close(); inbox.close(); controller.close(); tx.close(); rx.close(); });
    await f.alice.channel.queueMessage(f.bobId, 'manifest', { assetId: 'asset', context, manifest: media.privateManifest,
      sampleRate: 8000, channels: 2, frames: 24000, authorizationValidUntilMs: f.now + 30000 },
      { messageId: context.parentMessageId, expiresAtMs: f.now + 30000 });
    await tx.flush(f.bobId); await rx.pull(); assert.equal((await inbox.restoreManifests()).length, 1);
    let allowed = true;
    const options = await inbox.sessionOptions({ vault: f.bob.vault, consentedGainCeiling: 0.75,
      timeline: new ProgramTimeline(f.now, compileProgram('normalized', 8000, [{ id: 'clip', assetId: 'asset', frames: 24000, markerAfter: null }])),
      transport: receiver.chunksFrom(f.aliceId, { application: scope.application, tenantId: scope.tenantId }),
      authorizePlayback: async () => allowed ? { allowed: true, validUntilMs: f.now + 30000 } : { allowed: false } });
    bridge = new KernelBridge(() => 5000);
    session = platform === 'android' ? EndpointPlaybackSession.android({ ...options, bridge, native: { nowMonotonicMs: bridge.now } })
      : EndpointPlaybackSession.ios({ ...options, bridge, native: { nowHostTimeMs: bridge.now } });
    bridge.activate(1);
    await controller.issue({ operationId: 'normalized-lease', recipient: f.bobId, action: 'lease', expiresAtMs: f.now + 2000,
      payload: { expiresAtMs: f.now + 500, stopAtMs: f.now + 500, fadeMs: 100, maxLinearGain: 0.5 } });
    await tx.flush(f.bobId); const [received] = await rx.pull();
    await session.join(received.packet.record); await session.pump();
    assert.equal(relay.store.stats(f.now).chunks, 2);
    assert.ok(bridge.render(5050).every(sample => sample === 0.25));
    assert.ok(bridge.rawViews.every(view => view.every(sample => sample === 0)));
    allowed = false; await assert.rejects(session.pump(), /RIGHTS_DENIED/);
    assert.equal(bridge.samplesQueued, 0); assert.ok(bridge.render(5500).every(sample => sample === 0));
  });
}
