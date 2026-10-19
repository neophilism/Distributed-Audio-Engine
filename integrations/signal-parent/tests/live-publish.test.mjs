import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EncryptedLivePcmSegmenter, EndpointAttachmentReader, readAttachmentRange, decodeWave } from '../../../dist/src/index.js';
import { SignalPlaybackInbox, queueEncryptedLiveSegment } from '../src/index.mjs';
import { fixture, scope } from './helpers.mjs';

async function setup(t) {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const producer = new EncryptedLivePcmSegmenter({ scope,
    streamId: 'live-source', sampleRate: 8000, channels: 1, segmentFrames: 4 });
  t.after(() => producer.close());
  const [segment] = await producer.push(0n, new Float32Array([.25, -.25, .5, -.5]));
  assert.ok(segment);
  const uploaded = new Map(), sent = [];
  const relay = { async uploadChunk(request) {
    sent.push(structuredClone(request));
    const bytes = Uint8Array.from(Buffer.from(request.ciphertextBase64, 'base64'));
    uploaded.set(request.chunkIndex, bytes);
    return { status: 'stored',
      chunkId: createHash('sha256').update(request.ciphertextBase64).digest('hex') };
  }};
  function publish(extra = {}) { return queueEncryptedLiveSegment({ channel: f.alice.channel,
    relay, recipient: f.bobId, segment, nowUnixMs: () => f.now,
    authorizationValidUntilMs: f.now + 5000, expiresAtMs: f.now + 7000, ...extra }); }
  return { f, segment, relay, uploaded, sent, publish };
}
test('real Signal manifest follows authenticated ciphertext upload; the relay receives no private key or PCM', async t => {
  const p = await setup(t); let alreadyQueuedDuringUpload = false;
  const upload = p.relay.uploadChunk.bind(p.relay);
  p.relay.uploadChunk = async (...args) => {
    alreadyQueuedDuringUpload = (await p.f.alice.channel.pendingDeliveries(p.f.bobId)).length > 0;
    return upload(...args);
  };
  const result = await p.publish();
  assert.equal(alreadyQueuedDuringUpload, false);
  assert.equal(result.assetId, p.segment.privateManifest.parentMessageId);
  assert.equal(result.uploadedChunks, p.segment.privateManifest.chunkCount);
  assert.equal(p.sent.length, result.uploadedChunks);
  assert.equal(result.delivery.packet.recordType, 'signal');
  const wire = JSON.stringify({ records: p.sent, packet: result.delivery.packet });
  assert.equal(wire.includes(p.segment.privateManifest.attachmentKeyHex), false);
  assert.equal(wire.includes('maxLinearGain'), false);
  assert.equal(JSON.stringify(p.sent[0]).includes('manifest'), false);

  const inbox = new SignalPlaybackInbox({ channel: p.f.bob.channel, sender: p.f.aliceId,
    nowUnixMs: () => p.f.now, durable: true, vault: p.f.bob.vault }); t.after(() => inbox.close());
  assert.equal((await inbox.acceptManifest(result.delivery.packet.record)).assetId, result.assetId);
  const descriptor = await inbox.resolver.resolve(result.assetId, scope, new AbortController().signal);
  const reader = await EndpointAttachmentReader.open(descriptor.manifest, descriptor.context);
  try {
    const delivered = await readAttachmentRange(reader, {
      async read(request) { return p.uploaded.get(request.chunkIndex); },
    }, 0, reader.sizeBytes);
    assert.equal(delivered.integrity, 'whole-file-verified');
    const audio = decodeWave(delivered.plaintext);
    assert.equal(audio.sampleRate, 8000); assert.equal(audio.channels, 1);
    assert.equal(audio.samples.length, 4);
    assert.ok(Math.abs(audio.samples[0] - .25) < .0001);
    audio.samples.fill(0); delivered.plaintext.fill(0);
  } finally { reader.close(); }
});

test('upload uncertainty, malformed receipt, cancellation or forged scope never queue private manifest', async t => {
  const p = await setup(t);
  p.relay.uploadChunk = async () => { throw new Error('UPLOAD_UNCERTAIN'); };
  await assert.rejects(p.publish(), /UPLOAD_UNCERTAIN/);
  assert.deepEqual(await p.f.alice.channel.pendingDeliveries(p.f.bobId), []);
  p.relay.uploadChunk = async () => ({ status: 'acknowledged', chunkId: 'f'.repeat(64) });
  await assert.rejects(p.publish(), /LIVE_PUBLISH_RECEIPT/);
  assert.deepEqual(await p.f.alice.channel.pendingDeliveries(p.f.bobId), []);
  p.relay.uploadChunk = async () => ({ status: 'stored', chunkId: 'f'.repeat(64) });
  const aborted = new AbortController();
  p.relay.uploadChunk = async () => { aborted.abort(); return { status: 'stored', chunkId: 'f'.repeat(64) }; };
  await assert.rejects(p.publish({ signal: aborted.signal }), /LIVE_PUBLISH_ABORTED/);
  assert.deepEqual(await p.f.alice.channel.pendingDeliveries(p.f.bobId), []);
  await assert.rejects(p.publish({ segment: {
    ...p.segment, privateManifest: { ...p.segment.privateManifest, tenantId: 'forged' },
  } }), /SCOPE_OR_GEOMETRY/);
  assert.deepEqual(await p.f.alice.channel.pendingDeliveries(p.f.bobId), []);
});

test('altered ciphertext is rejected before it can reach the relay or encrypted manifest channel', async t => {
  const p = await setup(t);
  p.segment.ciphertextChunks[0][0] ^= 1;
  await assert.rejects(p.publish());
  assert.deepEqual(p.sent, []);
  assert.deepEqual(await p.f.alice.channel.pendingDeliveries(p.f.bobId), []);
});

test('in-flight peer revocation withholds the private descriptor after ciphertext upload', async t => {
  const p = await setup(t);
  p.relay.uploadChunk = async request => {
    p.sent.push(request);
    p.f.alice.channel.revokePeer(p.f.bobId);
    return { status: 'stored', chunkId: 'f'.repeat(64) };
  };
  await assert.rejects(p.publish(), /NOT_AUTHORIZED|MEMBERSHIP_CHANGED|REVOKED|PEER/);
  assert.equal(p.sent.length, 1);
  await assert.rejects(p.f.alice.channel.pendingDeliveries(p.f.bobId));
});

test('repeated completed publish keeps the exact durable manifest message identity', async t => {
  const p = await setup(t);
  const first = await p.publish(); const second = await p.publish();
  assert.equal(first.assetId, second.assetId);
  assert.deepEqual(second.delivery, first.delivery);
  assert.equal((await p.f.alice.channel.pendingDeliveries(p.f.bobId)).length, 1);
});
