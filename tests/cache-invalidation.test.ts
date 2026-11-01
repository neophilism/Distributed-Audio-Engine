import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CachingChunkTransport, EndpointCiphertextCache, MemoryCiphertextCacheStore } from '../src/cache.js';
const scope = { tenantId: 'tenant', application: 'distributed-radio' as const };
const request = { ...scope, storageObjectId: 'cipher', chunkIndex: 0, expectedBytes: 20 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function makeCache() {
  return new EndpointCiphertextCache(new MemoryCiphertextCacheStore(), scope,
    { maxBytes: 128, maxEntries: 4, maxRetentionMs: 1000 });
}
test('invalidation cancels all shared readers and late downloads cannot resurrect ciphertext', async () => {
  const cache = makeCache(), download = deferred<Uint8Array>(), invalidated = deferred<void>();
  let signal: AbortSignal | undefined, reads = 0;
  const transport = new CachingChunkTransport(cache, {
    async read(_request, current) { signal = current; return ++reads === 1 ? download.promise : new Uint8Array(20).fill(2); },
    async invalidate() { await invalidated.promise; }
  }, () => 100, 500);
  const readers = Array.from({ length: 64 }, () => transport.read(request));
  const outcomes = Promise.allSettled(readers);
  const invalidation = transport.invalidate(request);
  assert.equal(signal!.aborted, true);
  await assert.rejects(transport.read(request), /CACHE_INVALIDATION_IN_PROGRESS/);
  download.resolve(new Uint8Array(20).fill(1));
  assert.ok((await outcomes).every(result => result.status === 'rejected'));
  assert.deepEqual(cache.stats(100), { entries: 0, bytes: 0 });
  invalidated.resolve();
  await invalidation;
  assert.equal((await transport.read(request))[0], 2);
  assert.equal(reads, 2);
  transport.close();
});
test('overlapping invalidations keep the gate until the last upstream operation settles', async () => {
  const cache = makeCache(), first = deferred<void>(), second = deferred<void>();
  let invalidations = 0;
  const transport = new CachingChunkTransport(cache, {
    async read() { return new Uint8Array(20); },
    async invalidate() { await (++invalidations === 1 ? first.promise : second.promise); }
  }, () => 100, 500);
  const one = transport.invalidate(request), two = transport.invalidate(request);
  first.resolve(); await one;
  await assert.rejects(transport.read(request), /CACHE_INVALIDATION_IN_PROGRESS/);
  second.resolve(); await two;
  assert.equal((await transport.read(request)).length, 20);
  transport.close();
});
test('a failed invalidation does not strand unrelated reads or the retry gate', async () => {
  const cache = makeCache();
  const transport = new CachingChunkTransport(cache, {
    async read() { return new Uint8Array(20); },
    async invalidate() { throw new Error('injected upstream failure'); }
  }, () => 100, 500);
  await assert.rejects(transport.invalidate(request), /injected upstream failure/);
  assert.equal((await transport.read({ ...request, storageObjectId: 'other' })).length, 20);
  assert.equal((await transport.read(request)).length, 20);
  transport.close();
});

