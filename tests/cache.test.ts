import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CachingChunkTransport, encryptAttachment, EndpointAttachmentReader, EndpointCiphertextCache, MemoryCiphertextCacheStore, readAttachmentRange } from '../src/index.js';
import { SqliteCiphertextCacheStore } from '../src/node/index.js';
import type { ChunkRequest } from '../src/index.js';
const scope = { tenantId: 'tenant', application: 'distributed-radio' as const };
const request = (id: string, bytes = 20): ChunkRequest => ({ ...scope, storageObjectId: id, chunkIndex: 0, expectedBytes: bytes });
const limits = { maxBytes: 40, maxEntries: 2, maxRetentionMs: 1000 };
test('opaque cache snapshots ciphertext, isolates scopes and evicts the least recently accessed chunk', () => {
  const cache = new EndpointCiphertextCache(new MemoryCiphertextCacheStore(), scope, limits);
  const bytes = new Uint8Array(20).fill(7); cache.put(request('a'), bytes, 100, 900); bytes.fill(0);
  cache.put(request('b'), new Uint8Array(20), 101, 900); assert.equal(cache.get(request('a'), 102)![0], 7);
  cache.put(request('c'), new Uint8Array(20), 103, 900); assert.equal(cache.get(request('b'), 104), undefined); assert.equal(cache.get(request('a'), 104)![0], 7);
  const copy = cache.get(request('a'), 104)!; copy.fill(99); assert.equal(cache.get(request('a'), 104)![0], 7);
  assert.throws(() => cache.get({ ...request('a'), tenantId: 'other' }, 104), /SCOPE/); assert.deepEqual(cache.stats(104), { entries: 2, bytes: 40 });
});
test('expiry, conflicting duplicate data, entry limits and monotonic time fail closed', () => {
  const store = new MemoryCiphertextCacheStore(); const cache = new EndpointCiphertextCache(store, scope, limits);
  cache.put(request('a'), new Uint8Array(20), 100, 200);
  assert.throws(() => cache.put(request('a'), new Uint8Array(20).fill(1), 101, 250), /CONFLICT/);
  assert.throws(() => cache.put(request('b', 41), new Uint8Array(41), 101, 250), /TOO_LARGE/); assert.deepEqual(cache.stats(101), { entries: 1, bytes: 20 });
  cache.put(request('a'), new Uint8Array(20), 102, 300); assert.equal(cache.get(request('a'), 200), undefined);
  assert.throws(() => new EndpointCiphertextCache(store, scope, limits).stats(199));
  assert.throws(() => cache.put(request('x'), new Uint8Array(20), 201, 1202)); assert.equal(cache.deleteObject('a'), 0);
});
test('coalesced downloads share only ciphertext; canceling one listener preserves another', async () => {
  let fetches = 0; let release!: () => void; let upstreamSignal: AbortSignal | undefined;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const cache = new EndpointCiphertextCache(new MemoryCiphertextCacheStore(), scope, limits);
  const transport = new CachingChunkTransport(cache, { async read(_request, signal) { fetches++; upstreamSignal = signal; await barrier; return new Uint8Array(20).fill(4); } }, () => 100, 500);
  const a = new AbortController(); const b = new AbortController(); const one = transport.read(request('a'), a.signal); const two = transport.read(request('a'), b.signal);
  a.abort(); await assert.rejects(one); assert.equal(upstreamSignal!.aborted, false); release(); assert.equal((await two)[0], 4); assert.equal(fetches, 1);
  const fromCache = await transport.read(request('a')); fromCache.fill(0); assert.equal((await transport.read(request('a')))[0], 4); assert.equal(fetches, 1);
});
test('all canceled subscribers abort shared fetch and a fresh request does not inherit an abandoned operation', async () => {
  const cache = new EndpointCiphertextCache(new MemoryCiphertextCacheStore(), scope, limits); let fetches = 0; let release!: () => void; let oldSignal: AbortSignal | undefined;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const transport = new CachingChunkTransport(cache, { async read(_request, signal) { if (++fetches === 1) { oldSignal = signal; await barrier; } return new Uint8Array(20); } }, () => 100, 500);
  const abort = new AbortController(); const one = transport.read(request('a'), abort.signal); abort.abort(); await assert.rejects(one); assert.equal(oldSignal!.aborted, true);
  assert.equal((await transport.read(request('a'))).length, 20); assert.equal(fetches, 2); release(); await Promise.resolve();
  transport.close(); await assert.rejects(transport.read(request('a')), /CLOSED/);
});
test('cache authentication failure invalidates poisoned ciphertext before the next endpoint retry', async () => {
  const context = { ...scope, parentMessageId: 'parent' }; const encrypted = await encryptAttachment(new Uint8Array([1, 2, 3]), { ...context, filename: 'private.wav', mediaType: 'audio/wav' });
  const reader = await EndpointAttachmentReader.open(encrypted.privateManifest, context); let bad = true; let fetches = 0;
  const cache = new EndpointCiphertextCache(new MemoryCiphertextCacheStore(), scope, { ...limits, maxBytes: 100 });
  const transport = new CachingChunkTransport(cache, { async read() { fetches++; const chunk = Uint8Array.from(encrypted.ciphertextChunks[0]!); if (bad) chunk[0] = chunk[0]! ^ 1; return chunk; } }, () => 100, 500);
  await assert.rejects(readAttachmentRange(reader, transport, 0, 3)); assert.equal(cache.stats(100).entries, 0);
  bad = false; assert.deepEqual((await readAttachmentRange(reader, transport, 0, 3)).plaintext, new Uint8Array([1, 2, 3])); assert.equal(fetches, 2);
});
test('durable SQLite cache survives reopening and retains expiry and rollback watermark', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dae-cache-')); const path = join(dir, 'cache.sqlite');
  try {
    let store = new SqliteCiphertextCacheStore(path); let cache = new EndpointCiphertextCache(store, scope, limits);
    cache.put(request('a'), new Uint8Array(20).fill(9), 100, 200); store.close();
    store = new SqliteCiphertextCacheStore(path); cache = new EndpointCiphertextCache(store, scope, limits); assert.equal(cache.get(request('a'), 150)![0], 9); store.close();
    store = new SqliteCiphertextCacheStore(path); cache = new EndpointCiphertextCache(store, scope, limits); assert.throws(() => cache.get(request('a'), 149)); assert.equal(cache.get(request('a'), 200), undefined); store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('SQLite transaction failure rolls back both eviction and inserted rows', async () => {
  const store = new SqliteCiphertextCacheStore(':memory:');
  try {
    const cache = new EndpointCiphertextCache(store, scope, limits); cache.put(request('a'), new Uint8Array(20), 100, 500);
    assert.throws(() => store.transaction(() => { for (const r of store.list(JSON.stringify({ application: scope.application, tenantId: scope.tenantId }))) store.delete(r.key); throw new Error('injected failure'); }));
    assert.deepEqual(cache.stats(100), { entries: 1, bytes: 20 }); assert.equal(cache.get(request('a'), 100)!.length, 20);
  } finally { store.close(); }
});
test('persisted cache contains ciphertext and opaque indices without private media metadata or keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dae-cache-private-')); const path = join(dir, 'cache.sqlite');
  try {
    const context = { ...scope, parentMessageId: 'parent' }; const encrypted = await encryptAttachment(new TextEncoder().encode('secret audio content marker'), { ...context, filename: 'secret filename marker.wav', mediaType: 'audio/wav' });
    const store = new SqliteCiphertextCacheStore(path); const cache = new EndpointCiphertextCache(store, scope, { ...limits, maxBytes: 1000 });
    cache.put(request(encrypted.privateManifest.storageObjectId, encrypted.ciphertextChunks[0]!.length), encrypted.ciphertextChunks[0]!, 100, 500); store.close();
    const file = await readFile(path); for (const secret of ['secret audio content marker', 'secret filename marker.wav', encrypted.privateManifest.attachmentKeyHex]) assert.equal(file.includes(Buffer.from(secret)), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
