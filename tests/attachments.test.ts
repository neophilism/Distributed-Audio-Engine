import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptAttachment, decryptAttachment, validateManifest, MIN_CHUNK_SIZE } from '../src/index.js';
const context = { tenantId: 'tenant-a', application: 'distributed-radio' as const, parentMessageId: 'parent-a' };
const options = { ...context, filename: 'master.wav', mediaType: 'audio/wav' };
test('empty, short and multi-chunk media round trips with exact authentication overhead', async () => {
  for (const size of [0, 1, MIN_CHUNK_SIZE, MIN_CHUNK_SIZE * 2 + 17]) {
    const input = Uint8Array.from({ length: size }, (_, i) => i % 251);
    const result = await encryptAttachment(input, options);
    assert.deepEqual(await decryptAttachment(result.privateManifest, result.ciphertextChunks, context), input);
    assert.equal(result.ciphertextChunks.reduce((total, chunk) => total + chunk.length, 0), size + 16 * result.privateManifest.chunkCount);
  }
});
test('new objects and derivatives never reuse keys, object IDs or private manifests', async () => {
  const a = await encryptAttachment(new Uint8Array([1, 2]), options);
  const b = await encryptAttachment(new Uint8Array([1, 2]), options);
  assert.notEqual(a.privateManifest.attachmentKeyHex, b.privateManifest.attachmentKeyHex);
  assert.notEqual(a.privateManifest.attachmentId, b.privateManifest.attachmentId);
  assert.notEqual(a.privateManifest.storageObjectId, b.privateManifest.storageObjectId);
});
test('tampering, reordering, truncation and cross-object substitution fail', async () => {
  const a = await encryptAttachment(new Uint8Array(MIN_CHUNK_SIZE + 1), options);
  const b = await encryptAttachment(new Uint8Array(MIN_CHUNK_SIZE + 1), options);
  const bad = a.ciphertextChunks.map(x => Uint8Array.from(x)); bad[0]![0] = bad[0]![0]! ^ 1;
  for (const chunks of [bad, [...a.ciphertextChunks].reverse(), a.ciphertextChunks.slice(0, 1), b.ciphertextChunks]) {
    await assert.rejects(decryptAttachment(a.privateManifest, chunks, context));
  }
});
test('manifest binds private metadata and expected parent/tenant/application', async () => {
  const a = await encryptAttachment(new Uint8Array([1]), options);
  await assert.rejects(decryptAttachment({ ...a.privateManifest, filename: 'other.wav' }, a.ciphertextChunks, context));
  await assert.rejects(decryptAttachment(a.privateManifest, a.ciphertextChunks, { ...context, tenantId: 'other' }));
  await assert.rejects(decryptAttachment(a.privateManifest, a.ciphertextChunks, { ...context, application: 'scenesignal' }));
  await assert.rejects(decryptAttachment(a.privateManifest, a.ciphertextChunks, { ...context, parentMessageId: 'other' }));
  await assert.rejects(validateManifest({ ...a.privateManifest, unknown: true } as typeof a.privateManifest, context));
});
test('malformed sizes and invalid chunk configurations are rejected', async () => {
  for (const chunkSizeBytes of [1, MIN_CHUNK_SIZE - 1, 9 * 1024 * 1024, NaN]) await assert.rejects(encryptAttachment(new Uint8Array(), { ...options, chunkSizeBytes }));
  const a = await encryptAttachment(new Uint8Array(), options);
  await assert.rejects(validateManifest({ ...a.privateManifest, plaintextSizeBytes: -1 }, context));
  await assert.rejects(validateManifest({ ...a.privateManifest, chunkCount: 2 }, context));
});
