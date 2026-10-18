import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EncryptedLivePcmSegmenter, EndpointAttachmentReader, readAttachmentRange, decodeWave } from '../src/index.js';
import type { EncryptedLivePcmSegment } from '../src/index.js';

const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, sessionId: 'live-session' };
const options = { scope, streamId: 'local-live', sampleRate: 8000, channels: 1, segmentFrames: 4, gain: 0.5 };
async function readSegment(segment: EncryptedLivePcmSegment) {
  const context = { tenantId: scope.tenantId, application: scope.application,
    parentMessageId: segment.privateManifest.parentMessageId };
  const reader = await EndpointAttachmentReader.open(segment.privateManifest, context);
  try {
    const { plaintext } = await readAttachmentRange(reader, {
      async read(request) { return segment.ciphertextChunks[request.chunkIndex]!; },
    }, 0, reader.sizeBytes);
    try { return decodeWave(plaintext); }
    finally { plaintext.fill(0); }
  } finally { reader.close(); }
}
function near(actual: number, expected: number) { assert.ok(Math.abs(actual - expected) < 0.0001, `${actual} vs ${expected}`); }

test('bounded endpoint segments preserve a contiguous sample timeline with fresh encrypted manifests', async () => {
  const ingest = new EncryptedLivePcmSegmenter(options);
  const initial = Float32Array.from([0.2, -0.2]);
  assert.deepEqual(await ingest.push(0n, initial), []);
  initial.fill(0.9);
  const first = await ingest.push(2n, Float32Array.from([0.4, -0.4, 0.6, -0.6]));
  assert.equal(first.length, 1);
  assert.equal(first[0]!.startFrame, 0n); assert.equal(first[0]!.frames, 4);
  assert.equal(first[0]!.privateMetadata.frames, 4);
  assert.match(first[0]!.privateManifest.parentMessageId, /^local-live-[0-9a-f-]{36}-0$/);
  const second = await ingest.push(6n, Float32Array.from([0.8, -0.8]));
  assert.equal(second.length, 1);
  assert.equal(second[0]!.startFrame, 4n);
  assert.equal(second[0]!.privateManifest.parentMessageId, 'local-live-1');
  assert.notEqual(second[0]!.privateManifest.attachmentKeyHex, first[0]!.privateManifest.attachmentKeyHex);
  assert.notEqual(second[0]!.privateManifest.storageObjectId, first[0]!.privateManifest.storageObjectId);
  assert.equal(await ingest.flush(), null);
  assert.equal(ingest.snapshot().closed, true);
  const a = await readSegment(first[0]!);
  const b = await readSegment(second[0]!);
  for (const [i, expected] of [0.1, -0.1, 0.2, -0.2].entries()) near(a.samples[i]!, expected);
  for (const [i, expected] of [0.3, -0.3, 0.4, -0.4].entries()) near(b.samples[i]!, expected);
  a.samples.fill(0); b.samples.fill(0);
  await assert.rejects(ingest.push(8n, Float32Array.from([0.2])), /CLOSED/);
});

test('explicit short flush encrypts only actual remaining frames and closes the stream', async () => {
  const ingest = new EncryptedLivePcmSegmenter(options);
  assert.deepEqual(await ingest.push(0n, Float32Array.from([0.5, -0.5, 0.25])), []);
  const ending = await ingest.flush();
  assert.ok(ending);
  assert.equal(ending.frames, 3);
  assert.equal(ending.startFrame, 0n);
  assert.equal(ending.privateMetadata.frames, 3);
  const audio = await readSegment(ending);
  assert.equal(audio.samples.length, 3);
  near(audio.samples[0]!, 0.25);
  near(audio.samples[2]!, 0.125);
  audio.samples.fill(0);
  await assert.rejects(ingest.flush(), /CLOSED/);
});

test('invalid frame indices, shapes and out-of-range PCM cannot enter the encrypted stream', async () => {
  const ingest = new EncryptedLivePcmSegmenter(options);
  await assert.rejects(ingest.push(1n, Float32Array.from([0.2])), /DISCONTINUITY/);
  await assert.rejects(ingest.push(0n, Float32Array.from([NaN])), /INVALID|NONFINITE|FINITE/);
  await assert.rejects(ingest.push(0n, Float32Array.from([1.1])), /INVALID|RANGE/);
  await assert.rejects(ingest.push(0n, new Float32Array(17)), /INVALID|RANGE/);
  const valid = await ingest.push(0n, Float32Array.from([0.3, -0.3, 0.4, -0.4]));
  assert.equal(valid.length, 1); assert.equal(valid[0]!.startFrame, 0n);
  await assert.rejects(ingest.push(0n, Float32Array.from([0.3])), /DISCONTINUITY/);
  ingest.close();
  assert.equal(ingest.snapshot().pendingFrames, 0);
});

test('the live segmenter refuses overlapping capture and withholds encrypted output after close', async () => {
  const ingest = new EncryptedLivePcmSegmenter(options);
  const pending = ingest.push(0n, Float32Array.from([0.25, 0.25, 0.25, 0.25]));
  await assert.rejects(ingest.push(4n, Float32Array.from([0.1])), /BUSY/);
  ingest.close();
  await assert.rejects(pending, /CLOSED/);
  assert.equal(ingest.snapshot().closed, true);
});

test('cancelled capture and invalid stream bounds are rejected without normalization or silent fallback', async () => {
  assert.throws(() => new EncryptedLivePcmSegmenter({ ...options, gain: 1.1 }));
  assert.throws(() => new EncryptedLivePcmSegmenter({ ...options, channels: 2, segmentFrames: 192000 }));
  assert.throws(() => new EncryptedLivePcmSegmenter({ ...options, startFrame: -1n }), /START_FRAME/);
  const ingest = new EncryptedLivePcmSegmenter(options);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(ingest.push(0n, Float32Array.from([0.1]), controller.signal), /ABORTED/);
  assert.equal(ingest.snapshot().nextFrame, 0n);
  ingest.close();
});
