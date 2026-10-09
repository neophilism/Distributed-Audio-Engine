import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptAttachment, EndpointAttachmentReader, FetchChunkTransport, MIN_CHUNK_SIZE, readAttachmentRange } from '../src/index.js';
import type { ChunkRequest, CiphertextChunkTransport } from '../src/index.js';
const context = { tenantId: 'tenant-a', application: 'distributed-radio' as const, parentMessageId: 'parent-a' };
async function fixture(size = MIN_CHUNK_SIZE * 3 + 7) {
  const input = Uint8Array.from({ length: size }, (_, i) => i % 251);
  const encrypted = await encryptAttachment(input, { ...context, filename: 'private-name.wav', mediaType: 'audio/wav' });
  const reader = await EndpointAttachmentReader.open(encrypted.privateManifest, context);
  const calls: ChunkRequest[] = [];
  const transport: CiphertextChunkTransport = { async read(request) { calls.push(request); return encrypted.ciphertextChunks[request.chunkIndex]!; } };
  return { input, encrypted, reader, calls, transport };
}
test('ranges authenticate only the required chunks and disclose only opaque transport fields', async () => {
  const f = await fixture();
  const range = await readAttachmentRange(f.reader, f.transport, MIN_CHUNK_SIZE + 3, MIN_CHUNK_SIZE * 2 + 2);
  assert.deepEqual(range.plaintext, f.input.slice(MIN_CHUNK_SIZE + 3, MIN_CHUNK_SIZE * 2 + 2));
  assert.equal(range.integrity, 'chunk-authenticated'); assert.deepEqual(f.calls.map(x => x.chunkIndex), [1, 2]);
  assert.equal(JSON.stringify(f.calls).includes('private-name'), false);
  assert.equal(JSON.stringify(f.calls).includes(f.encrypted.privateManifest.attachmentKeyHex), false);
});
test('complete and empty reads verify whole-file integrity; malformed ranges fail before fetching', async () => {
  for (const size of [0, 17, MIN_CHUNK_SIZE + 2]) {
    const f = await fixture(size); const result = await readAttachmentRange(f.reader, f.transport, 0, size);
    assert.deepEqual(result.plaintext, f.input); assert.equal(result.integrity, 'whole-file-verified');
  }
  const f = await fixture();
  for (const [from, to] of [[-1, 2], [2, 1], [0, f.input.length + 1]]) await assert.rejects(readAttachmentRange(f.reader, f.transport, from!, to!));
  await assert.rejects(readAttachmentRange(f.reader, f.transport, 0, 20, { maxReadBytes: 19 })); assert.equal(f.calls.length, 0);
});
test('wrong-position substitution, tamper and late cancellation never return plaintext', async () => {
  const f = await fixture();
  await assert.rejects(readAttachmentRange(f.reader, { async read() { return f.encrypted.ciphertextChunks[1]!; } }, 0, 10));
  const bad = Uint8Array.from(f.encrypted.ciphertextChunks[0]!); bad[0] = bad[0]! ^ 1;
  await assert.rejects(readAttachmentRange(f.reader, { async read() { return bad; } }, 0, 10));
  const abort = new AbortController();
  await assert.rejects(readAttachmentRange(f.reader, { async read(request) { abort.abort(); return f.encrypted.ciphertextChunks[request.chunkIndex]!; } }, 0, 10, { signal: abort.signal }), /DELIVERY_ABORTED/);
  const closing = await fixture();
  await assert.rejects(readAttachmentRange(closing.reader, { async read(request) { closing.reader.close(); return closing.encrypted.ciphertextChunks[request.chunkIndex]!; } }, 0, 10), /READER_CLOSED/);
});
test('reader snapshots authenticated manifest and checks complete plaintext hash', async () => {
  const f = await fixture(17); f.encrypted.privateManifest.storageObjectId = 'changed'; f.encrypted.privateManifest.attachmentKeyHex = '0'.repeat(64);
  assert.deepEqual((await readAttachmentRange(f.reader, f.transport, 0, 17)).plaintext, f.input);
  await assert.rejects(f.reader.verifyComplete(new Uint8Array(17)), /FILE_HASH_MISMATCH/);
});
test('HTTPS transport bounds streamed bytes and refuses invalid origin or download capability', async () => {
  const request: ChunkRequest = { tenantId: 'tenant', application: 'scenesignal', storageObjectId: 'object', chunkIndex: 2, expectedBytes: 17 };
  let captured: { url: string; init?: RequestInit } | undefined;
  const transport = new FetchChunkTransport({ origin: 'https://ciphertext.example', authorize: async () => 'opaque-capability', fetch: async (url, init) => { captured = { url: String(url), ...(init ? { init } : {}) }; return new Response(new Uint8Array(17)); } });
  assert.equal((await transport.read(request)).length, 17);
  assert.equal(captured!.url, 'https://ciphertext.example/scenesignal/tenant/objects/object/chunks/2');
  assert.equal(captured!.init!.redirect, 'error'); assert.equal(captured!.init!.credentials, 'omit'); assert.equal(captured!.init!.referrerPolicy, 'no-referrer');
  for (const origin of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?key=secret']) assert.throws(() => new FetchChunkTransport({ origin, authorize: async () => 'a' }));
  await assert.rejects(new FetchChunkTransport({ origin: 'https://example.com', authorize: async () => 'bad\r\nheader' }).read(request), /CAPABILITY/);
  for (const size of [16, 18]) await assert.rejects(new FetchChunkTransport({ origin: 'https://example.com', authorize: async () => 'a', fetch: async () => new Response(new Uint8Array(size)) }).read(request));
  await assert.rejects(new FetchChunkTransport({ origin: 'https://example.com', authorize: async () => 'a', fetch: async () => new Response(new Uint8Array(17), { headers: { 'content-length': '999' } }) }).read(request));
});
