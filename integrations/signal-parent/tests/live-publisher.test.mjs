import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EncryptedLivePcmSegmenter } from '../../../dist/src/index.js';
import { EndpointLivePublisher, SignalPlaybackInbox } from '../src/index.mjs';
import { fixture, scope } from './helpers.mjs';

async function setup(t, authorize) {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const segmenter = new EncryptedLivePcmSegmenter({ scope, streamId: 'live-foreground',
    sampleRate: 8000, channels: 1, segmentFrames: 4 });
  let uploads = [];
  const relay = { async uploadChunk(request) {
    uploads.push(structuredClone(request));
    return { status: 'stored',
      chunkId: createHash('sha256').update(request.ciphertextBase64).digest('hex') };
  } };
  const publisher = new EndpointLivePublisher({ segmenter, channel: f.alice.channel,
    relay, recipient: f.bobId, nowUnixMs: () => f.now,
    authorizePublication: authorize ?? (async () => ({ allowed: true,
      authorizationValidUntilMs: f.now + 5000, expiresAtMs: f.now + 7000 })) });
  t.after(() => publisher.close());
  return { f, publisher, uploads, relay };
}

test('sequential source frames upload ciphertext then queue two distinct encrypted manifests', async t => {
  const p = await setup(t);
  const receipts = await p.publisher.push(0n, Float32Array.from([.5,-.5,.25,-.25,.75,-.75,.1,-.1]));
  assert.equal(receipts.length, 2);
  assert.equal(p.publisher.snapshot().published, 2);
  assert.equal(receipts[0].segmentIndex, 0); assert.equal(receipts[1].segmentIndex, 1);
  assert.notEqual(receipts[0].assetId, receipts[1].assetId);
  assert.equal(receipts[0].uploadedChunks, 1);
  assert.equal(p.uploads.length, 2);
  const queued = await p.f.alice.channel.pendingDeliveries(p.f.bobId);
  assert.equal(queued.length, 2);
  assert.equal(queued[0].packet.deliveryId, receipts[0].deliveryId);
  assert.equal(queued[1].packet.deliveryId, receipts[1].deliveryId);
  for (const row of queued) {
    assert.equal(row.packet.recordType, 'signal');
    assert.equal(JSON.stringify(row).includes('attachmentKeyHex'), false);
  }
  const inbox = new SignalPlaybackInbox({ channel: p.f.bob.channel, sender: p.f.aliceId,
    nowUnixMs: () => p.f.now, durable: true, vault: p.f.bob.vault });
  t.after(() => inbox.close());
  for (const row of queued) {
    const accepted = await inbox.acceptManifest(row.packet.record);
    assert.equal(accepted.assetId, row.packet.deliveryId);
  }
  assert.deepEqual(await p.publisher.flush(), []);
  assert.equal(p.publisher.snapshot().closed, true);
});

test('denied rights in the second segment close source with no second encrypted manifest', async t => {
  const p = await setup(t, async segmentIndex => segmentIndex === 0 ?
    { allowed: true, authorizationValidUntilMs: 1800000005000, expiresAtMs: 1800000007000 } :
    { allowed: false });
  await assert.rejects(p.publisher.push(0n,
    Float32Array.from([.1,.1,.1,.1,.2,.2,.2,.2])), /LIVE_PUBLISH_RIGHTS_DENIED/);
  assert.deepEqual(p.publisher.snapshot(), { closed: true, busy: false, published: 1 });
  assert.equal(p.uploads.length, 1);
  assert.equal((await p.f.alice.channel.pendingDeliveries(p.f.bobId)).length, 1);
  await assert.rejects(p.publisher.push(8n, Float32Array.from([.3])), /CLOSED_OR_BUSY/);
});

test('final short source flush publishes only the remaining frames and closes permanently', async t => {
  const p = await setup(t);
  assert.deepEqual(await p.publisher.push(0n, Float32Array.from([.5,-.5,.25])), []);
  const results = await p.publisher.flush();
  assert.equal(results.length, 1);
  assert.equal(results[0].segmentIndex, 0);
  assert.equal(p.publisher.snapshot().published, 1);
  assert.equal(p.publisher.snapshot().closed, true);
  assert.equal((await p.f.alice.channel.pendingDeliveries(p.f.bobId)).length, 1);
  assert.equal(p.uploads.length, 1);
  await assert.rejects(p.publisher.flush(), /CLOSED_OR_BUSY/);
});

test('explicit close aborts a pending rights callback and withholds encrypted publication', async t => {
  let entered;
  const wait = new Promise(resolve => { entered = resolve; });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const p = await setup(t, async () => { entered(); return pending; });
  const task = p.publisher.push(0n, Float32Array.from([.5,-.5,.5,-.5]));
  await wait; p.publisher.close();
  release({ allowed: true, authorizationValidUntilMs: p.f.now + 5000, expiresAtMs: p.f.now + 7000 });
  await assert.rejects(task, /LIVE_PUBLISHER_CLOSED/);
  assert.equal(p.uploads.length, 0);
  assert.deepEqual(await p.f.alice.channel.pendingDeliveries(p.f.bobId), []);
});

test('concurrent capture, invalid rights and cancellation fail closed without implicit retries', async t => {
  const p = await setup(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(p.publisher.push(0n, Float32Array.from([.1]), controller.signal), /ABORTED/);
  assert.equal(p.publisher.snapshot().closed, true);
  assert.equal(p.publisher.snapshot().published, 0);
  const other = await setup(t);
  const original = other.relay.uploadChunk.bind(other.relay);
  let release;
  const locked = new Promise(resolve => { release = resolve; });
  other.relay.uploadChunk = async request => { await locked; return original(request); };
  const first = other.publisher.push(0n, Float32Array.from([.2,.2,.2,.2]));
  await assert.rejects(other.publisher.push(4n, Float32Array.from([.2])), /CLOSED_OR_BUSY/);
  other.publisher.close(); release();
  await assert.rejects(first, /LIVE_PUBLISH_ABORTED|LIVE_PUBLISHER_CLOSED/);
});
