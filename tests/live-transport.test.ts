import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EncryptedLivePcmSegmenter } from '../src/live-input.js';
import { describeLiveSegment } from '../src/live-continuity.js';
import { LiveSegmentPublisher } from '../src/live-transport.js';

const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, sessionId: 'session' };
const source = { scope, streamId: 'live', sampleRate: 8000, channels: 1, segmentFrames: 4 };
async function segments() {
  const producer = new EncryptedLivePcmSegmenter(source);
  const first = (await producer.push(0n, Float32Array.of(0.1, 0.2, 0.3, 0.4)))[0]!;
  const second = (await producer.push(4n, Float32Array.of(0.5, 0.6, 0.7, 0.8)))[0]!;
  return { first, second };
}

test('ciphertext is stored before the private manifest is delivered, in frame order', async () => {
  const { first, second } = await segments();
  const calls: string[] = [];
  const publisher = new LiveSegmentPublisher({
    scope, captureId: describeLiveSegment(first).captureId, sampleRate: 8000, channels: 1,
    readers: ['recipient'], expiresAtMs: 5000, nowMs: () => 1000,
    upload: async request => {
      assert.deepEqual(Object.keys(request).sort(), [
        'application', 'chunkIndex', 'ciphertext', 'expiresAtMs', 'readers', 'storageObjectId', 'tenantId'
      ]);
      assert.equal(request.tenantId, scope.tenantId);
      assert.ok(request.ciphertext.byteLength > 16);
      calls.push('ciphertext');
    },
    deliverPrivate: async delivery => {
      assert.match(delivery.privateManifest.attachmentKeyHex, /^[0-9a-f]{64}$/);
      calls.push('private-' + delivery.notice.segmentIndex);
    }
  });
  await publisher.publish(first);
  await publisher.publish(second);
  assert.deepEqual(calls, ['ciphertext', 'private-0', 'ciphertext', 'private-1']);
  assert.equal(publisher.snapshot().nextFrame, 8n);
  publisher.close();
  assert.equal(publisher.snapshot().closed, true);
});

test('upload failure withholds private metadata and permanently stops this publisher', async () => {
  const { first } = await segments();
  let privateCalls = 0;
  const publisher = new LiveSegmentPublisher({
    scope, captureId: describeLiveSegment(first).captureId, sampleRate: 8000, channels: 1,
    readers: ['recipient'], expiresAtMs: 5000, nowMs: () => 1000,
    upload: async () => { throw new Error('relay unavailable'); },
    deliverPrivate: async () => { privateCalls++; }
  });
  await assert.rejects(publisher.publish(first), /relay unavailable/);
  assert.equal(privateCalls, 0);
  assert.equal(publisher.snapshot().closed, true);
  await assert.rejects(publisher.publish(first), /CLOSED_OR_BUSY/);
});

test('replay, cross-scope, expired and cancelled publication fail closed', async () => {
  const { first, second } = await segments();
  const make = (expiresAtMs = 5000) => new LiveSegmentPublisher({
    scope, captureId: describeLiveSegment(first).captureId, sampleRate: 8000, channels: 1,
    readers: ['recipient'], expiresAtMs, nowMs: () => 1000,
    upload: async () => {}, deliverPrivate: async () => {}
  });
  const replay = make();
  await replay.publish(first);
  await assert.rejects(replay.publish(first), /INDEX_GAP_OR_REPLAY/);
  assert.equal(replay.snapshot().closed, true);
  const gap = make();
  await assert.rejects(gap.publish(second), /INDEX_GAP_OR_REPLAY/);
  const wrongScope = make();
  await assert.rejects(wrongScope.publish({
    ...first, privateManifest: { ...first.privateManifest, tenantId: 'other' }
  }), /SCOPE_MISMATCH/);
  const expired = make(999);
  await assert.rejects(expired.publish(first), /EXPIRED/);
  const cancelled = make();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(cancelled.publish(first, controller.signal), /ABORTED/);
});

test('private delivery failure stops an uncertain publication without retrying', async () => {
  const { first } = await segments();
  let uploads = 0;
  const publisher = new LiveSegmentPublisher({
    scope, captureId: describeLiveSegment(first).captureId, sampleRate: 8000, channels: 1,
    readers: ['recipient'], expiresAtMs: 5000, nowMs: () => 1000,
    upload: async () => { uploads++; },
    deliverPrivate: async () => { throw new Error('unknown delivery outcome'); }
  });
  await assert.rejects(publisher.publish(first), /unknown delivery outcome/);
  assert.equal(uploads, 1);
  assert.equal(publisher.snapshot().closed, true);
  await assert.rejects(publisher.publish(first), /CLOSED_OR_BUSY/);
  assert.equal(uploads, 1);
});

test('publisher snapshots mutable caller options before asynchronous delivery', async () => {
  const { first } = await segments();
  const mutableScope = { ...scope };
  const readers = ['recipient'];
  const observed: string[] = [];
  const options = {
    scope: mutableScope, captureId: describeLiveSegment(first).captureId,
    sampleRate: 8000, channels: 1, readers, expiresAtMs: 5000, nowMs: () => 1000,
    upload: async (request: { tenantId: string; readers: readonly string[] }) => {
      observed.push(request.tenantId, ...request.readers);
    },
    deliverPrivate: async () => {}
  };
  const publisher = new LiveSegmentPublisher(options);
  mutableScope.tenantId = 'other';
  readers.push('intruder');
  options.expiresAtMs = 99999999;
  await publisher.publish(first);
  assert.deepEqual(observed, ['tenant', 'recipient']);
});
