import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EncryptedLivePcmSegmenter, EndpointAttachmentReader, readAttachmentRange, decodeWave } from '../../../dist/src/index.js';
import { queueEncryptedLiveSegment, SignalRelayEndpoint, SignalPlaybackInbox } from '../../../integrations/signal-parent/src/index.mjs';
import { fixture, scope } from '../../../integrations/signal-parent/tests/helpers.mjs';
import { relayFixture } from './helpers.mjs';

test('real TLS relay stores live ciphertext before delivering an authenticated private Signal manifest', async t => {
  const f = await fixture(); t.after(() => f.close());
  const relay = await relayFixture(t, { addresses: [f.aliceId, f.bobId], clock: () => f.now });
  const [sender, receiver] = relay.clients;
  await receiver.publishBundle(await f.bob.channel.publicBundle());
  const publicBundle = await sender.takeBundle(f.bobId);
  await f.alice.channel.connect(f.bobId, publicBundle);

  const encoder = new EncryptedLivePcmSegmenter({ scope, streamId: 'live-program',
    sampleRate: 8000, channels: 2, segmentFrames: 8 });
  t.after(() => encoder.close());
  const samples = Float32Array.from({ length: 16 }, (_, i) => i % 2 ? -0.5 : 0.5);
  const [segment] = await encoder.push(0n, samples);
  assert.ok(segment);
  const send = await queueEncryptedLiveSegment({ channel: f.alice.channel, relay: sender,
    recipient: f.bobId, segment, nowUnixMs: () => f.now,
    authorizationValidUntilMs: f.now + 5000, expiresAtMs: f.now + 7000 });
  assert.equal(send.uploadedChunks, segment.privateManifest.chunkCount);
  assert.equal(relay.store.stats(f.now).chunks, send.uploadedChunks);
  assert.equal((await receiver.poll()).length, 0);

  const tx = new SignalRelayEndpoint({ channel: f.alice.channel, relay: sender, nowUnixMs: () => f.now });
  t.after(() => tx.close());
  assert.deepEqual(await tx.flush(f.bobId), { sent: 1 });
  const inbox = new SignalPlaybackInbox({ channel: f.bob.channel, sender: f.aliceId, nowUnixMs: () => f.now,
    durable: true, vault: f.bob.vault });
  t.after(() => inbox.close());
  const [row] = await receiver.poll(); assert.ok(row);
  assert.equal(row.packet.recordType, 'signal');
  const accepted = await inbox.acceptManifest(row.packet.record);
  assert.equal(accepted.assetId, send.assetId);
  await receiver.acknowledge([row.receiptId]);
  const descriptor = await inbox.resolver.resolve(send.assetId, scope, new AbortController().signal);
  const reader = await EndpointAttachmentReader.open(descriptor.manifest, descriptor.context);
  try {
    const delivered = await readAttachmentRange(reader,
      receiver.chunksFrom(f.aliceId, { tenantId: scope.tenantId, application: scope.application }),
      0, reader.sizeBytes);
    assert.equal(delivered.integrity, 'whole-file-verified');
    const audio = decodeWave(delivered.plaintext);
    assert.equal(audio.sampleRate, 8000); assert.equal(audio.channels, 2);
    assert.equal(audio.samples.length, 16);
    assert.ok(Math.abs(audio.samples[0] - 0.5) < .0001);
    assert.ok(Math.abs(audio.samples[1] + 0.5) < .0001);
    audio.samples.fill(0); delivered.plaintext.fill(0);
  } finally { reader.close(); }
  // Actual authenticated TLS receipt is NOT a claim of physical sound, nor
  // evidence that a mobile player was started or a session lease issued.
});
