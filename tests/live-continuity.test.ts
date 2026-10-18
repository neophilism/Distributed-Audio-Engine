import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EncryptedLivePcmSegmenter, LiveSegmentContinuity, describeLiveSegment } from '../src/index.js';
import type { LiveSegmentNotice } from '../src/index.js';

const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, sessionId: 'live' };
const options = { scope, streamId: 'live-feed', sampleRate: 8000, channels: 1, segmentFrames: 4 };
const fill = (...samples: number[]) => Float32Array.from(samples);
async function pair() {
  const producer = new EncryptedLivePcmSegmenter(options);
  const [a, b] = await producer.push(0n, fill(.1, .2, .3, .4, .5, .6, .7, .8));
  assert.ok(a && b);
  const first = describeLiveSegment(a), second = describeLiveSegment(b);
  const receiver = new LiveSegmentContinuity({
    captureId: first.captureId, sampleRate: 8000, channels: 1,
  });
  return { producer, receiver, first, second };
}

test('live source metadata becomes JSON-safe and exact authenticated-order geometry', async () => {
  const p = await pair();
  assert.equal(JSON.parse(JSON.stringify(p.first)).startFrameDecimal, '0');
  assert.equal(p.first.parentMessageId, p.first.captureId + '-0');
  assert.equal(p.second.parentMessageId, p.first.captureId + '-1');
  const parsed = Object.assign(Object.create(null), structuredClone(p.first)) as LiveSegmentNotice;
  assert.deepEqual(p.receiver.accept(parsed),
    { segmentIndex: 0, startFrame: 0n, nextFrame: 4n });
  assert.deepEqual(p.receiver.accept(structuredClone(p.second)),
    { segmentIndex: 1, startFrame: 4n, nextFrame: 8n });
  assert.deepEqual(p.receiver.snapshot(), { closed: false, nextIndex: 2, nextFrame: 8n });
  p.receiver.close(); p.producer.close();
  assert.throws(() => p.receiver.accept(p.second), /CLOSED/);
});

test('out-of-order, duplicate or missing segments fail without advancing the receiver cursor', async () => {
  const p = await pair();
  assert.throws(() => p.receiver.accept(p.second), /INDEX_GAP_OR_REPLAY/);
  assert.deepEqual(p.receiver.snapshot(), { closed: false, nextIndex: 0, nextFrame: 0n });
  p.receiver.accept(p.first);
  assert.throws(() => p.receiver.accept(p.first), /INDEX_GAP_OR_REPLAY/);
  assert.throws(() => p.receiver.accept({ ...p.second, startFrameDecimal: '5' }), /FRAME_GAP_OR_REPLAY/);
  assert.equal(p.receiver.snapshot().nextFrame, 4n);
  p.receiver.accept(p.second); p.producer.close();
});

test('foreign captures and changed format cannot be inserted even with valid sequence numbers', async () => {
  const p = await pair();
  const another = new EncryptedLivePcmSegmenter(options);
  const other = describeLiveSegment((await another.push(0n, fill(.2, .2, .2, .2)))[0]!);
  assert.notEqual(other.captureId, p.first.captureId);
  assert.throws(() => p.receiver.accept(other), /CAPTURE_MISMATCH/);
  assert.throws(() => p.receiver.accept({ ...p.first, channels: 2 }), /FORMAT_MISMATCH/);
  assert.throws(() => p.receiver.accept({ ...p.first, sampleRate: 16000 }), /FORMAT_MISMATCH/);
  assert.throws(() => p.receiver.accept({
    ...p.first, parentMessageId: other.parentMessageId,
  }), /ID_MISMATCH/);
  assert.deepEqual(p.receiver.snapshot(), { closed: false, nextIndex: 0, nextFrame: 0n });
  p.receiver.accept(p.first); p.producer.close(); another.close();
});

test('non-canonical wire frame encodings, exaggerated lengths and injected fields fail closed', async () => {
  const p = await pair();
  for (const startFrameDecimal of ['00', '+0', '-1', '1e3', ' 0', '18446744073709551616']) {
    assert.throws(() => p.receiver.accept({ ...p.first, startFrameDecimal }), /NONCANONICAL|OVERFLOW/);
  }
  assert.throws(() => p.receiver.accept({ ...p.first, frames: 0 }), /INVALID|RANGE/);
  assert.throws(() => p.receiver.accept({ ...p.first, frames: 16000 }), /INVALID|RANGE/);
  assert.throws(() => p.receiver.accept({ ...p.first, ignored: true } as LiveSegmentNotice), /FIELDS/);
  assert.throws(() => p.receiver.accept({ ...p.first, segmentIndex: 1 }), /ID_MISMATCH/);
  const accessor = { ...p.first };
  Object.defineProperty(accessor, 'captureId', { get() { throw new Error('GETTER_EXECUTED'); }, enumerable: true });
  assert.throws(() => p.receiver.accept(accessor), /FIELDS/);
  assert.deepEqual(p.receiver.snapshot(), { closed: false, nextIndex: 0, nextFrame: 0n });
  p.producer.close();
});

test('publisher notices reject tampered source geometry and mismatched manifest identities', async () => {
  const publisher = new EncryptedLivePcmSegmenter(options);
  const segment = (await publisher.push(0n, fill(.1, .2, .3, .4)))[0]!;
  assert.throws(() => describeLiveSegment({ ...segment, frames: 3 }), /SOURCE_GEOMETRY/);
  assert.throws(() => describeLiveSegment({
    ...segment, privateManifest: { ...segment.privateManifest, parentMessageId: 'other-capture' },
  }), /PARENT_ID/);
  assert.match(describeLiveSegment(segment).parentMessageId, /^live-feed-/);
  publisher.close();
});

test('the receiver honors explicit nonzero capture positions without synthetic catch-up', async () => {
  const producer = new EncryptedLivePcmSegmenter({ ...options, startFrame: 4096n });
  const notice = describeLiveSegment((await producer.push(4096n, fill(.1, .2, .3, .4)))[0]!);
  const receiver = new LiveSegmentContinuity({ captureId: notice.captureId,
    sampleRate: 8000, channels: 1, initialFrame: 4096n });
  assert.deepEqual(receiver.accept(notice),
    { segmentIndex: 0, startFrame: 4096n, nextFrame: 4100n });
  producer.close(); receiver.close();
});
