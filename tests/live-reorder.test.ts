import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoundedLiveNoticeReorder, EncryptedLivePcmSegmenter, describeLiveSegment } from '../src/index.js';
import type { LiveSegmentNotice } from '../src/index.js';

const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, sessionId: 'live' };
async function fixture(maxBufferedNotices = 3) {
  const source = new EncryptedLivePcmSegmenter({ scope, streamId: 'listener',
    sampleRate: 8000, channels: 1, segmentFrames: 2 });
  const segments = await source.push(0n, Float32Array.from([.2,.2,.3,.3,.4,.4]));
  const notices = segments.map(segment => describeLiveSegment(segment));
  const first = notices[0]!;
  const queue = new BoundedLiveNoticeReorder({ captureId: first.captureId,
    sampleRate: 8000, channels: 1, maxBufferedNotices });
  return { source, queue, notices };
}
test('out-of-order authenticated notices release only after each missing prefix arrives', async () => {
  const p = await fixture();
  const [a,b,c] = p.notices;
  assert.deepEqual(p.queue.offer(c!), []);
  assert.deepEqual(p.queue.snapshot().bufferedIndices, [2]);
  assert.deepEqual(p.queue.offer(b!), []);
  assert.deepEqual(p.queue.snapshot().bufferedIndices, [1,2]);
  assert.deepEqual(p.queue.offer(a!), [a,b,c]);
  assert.deepEqual(p.queue.snapshot(), { closed: false, nextIndex: 3,
    nextFrame: 6n, bufferedIndices: [] });
  p.source.close(); p.queue.close();
});

test('replayed, duplicate-pending or excessively future notices fail before state changes', async () => {
  const p = await fixture(2);
  const [a,b,c] = p.notices;
  assert.deepEqual(p.queue.offer(c!), []);
  assert.throws(() => p.queue.offer(c!), /DUPLICATE_PENDING/);
  assert.throws(() => p.queue.offer({ ...c!, segmentIndex: 3,
    parentMessageId: c!.captureId + '-3' }), /OUT_OF_RANGE|INVALID_INTEGER|INVALID|RANGE/);
  assert.deepEqual(p.queue.snapshot().bufferedIndices, [2]);
  assert.deepEqual(p.queue.offer(a!), [a]);
  assert.deepEqual(p.queue.offer(b!), [b,c]);
  assert.throws(() => p.queue.offer(a!), /INVALID|RANGE|INTEGER/);
  p.source.close(); p.queue.close();
});

test('queued notices are copied so caller mutation cannot replace future PCM position', async () => {
  const p = await fixture(); const [a,b,c] = p.notices;
  const mutable = { ...b! } as LiveSegmentNotice;
  assert.deepEqual(p.queue.offer(mutable), []);
  mutable.startFrameDecimal = '900'; mutable.frames = 1;
  assert.deepEqual(p.queue.offer(c!), []);
  const released = p.queue.offer(a!);
  assert.equal(released[1]!.startFrameDecimal, '2');
  assert.equal(released[1]!.frames, 2);
  p.source.close(); p.queue.close();
});

test('wrong capture, channels or discontinuous future frame never partially advance the cursor', async () => {
  const p = await fixture(); const [a,b,c] = p.notices;
  assert.throws(() => p.queue.offer({ ...b!, captureId: 'other' }), /ID_MISMATCH|CAPTURE_MISMATCH/);
  assert.throws(() => p.queue.offer({ ...b!, channels: 2 }), /FORMAT_MISMATCH/);
  assert.deepEqual(p.queue.offer({ ...b!, startFrameDecimal: '100' }), []);
  assert.deepEqual(p.queue.offer(c!), []);
  assert.throws(() => p.queue.offer(a!), /FRAME_DISCONTINUITY/);
  assert.deepEqual(p.queue.snapshot(), { closed: false, nextIndex: 0,
    nextFrame: 0n, bufferedIndices: [1,2] });
  p.source.close(); p.queue.close();
});

test('close clears the bounded notice cache and never authorizes implicit recovery', async () => {
  const p = await fixture(); const [a,b,c] = p.notices;
  assert.deepEqual(p.queue.offer(c!), []);
  p.queue.close(); p.source.close();
  assert.deepEqual(p.queue.snapshot().bufferedIndices, []);
  assert.throws(() => p.queue.offer(a!), /CLOSED/);
  assert.throws(() => new BoundedLiveNoticeReorder({ captureId: a!.captureId,
    sampleRate: 8000, channels: 1, maxBufferedNotices: 65 }), /INVALID|RANGE/);
});
