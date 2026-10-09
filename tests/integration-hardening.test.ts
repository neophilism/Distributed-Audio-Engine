import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CachingChunkTransport, CoordinatorMonitor, ControlVerifier, DisciplinedClock, EndpointCiphertextCache, FetchChunkTransport, MemoryCheckpointStore, MemoryCiphertextCacheStore } from '../src/index.js';
const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, sessionId: 'session' };
const request = { tenantId: scope.tenantId, application: scope.application, storageObjectId: 'object', chunkIndex: 0, expectedBytes: 20 };
test('closing a cache transport settles callers even when an upstream ignores cancellation', async () => {
  const cache = new EndpointCiphertextCache(new MemoryCiphertextCacheStore(), scope, { maxBytes: 100, maxEntries: 2, maxRetentionMs: 1000 });
  const transport = new CachingChunkTransport(cache, { async read() { return new Promise<Uint8Array>(() => undefined); } }, () => 100, 500);
  const pending = transport.read(request); transport.close(); await assert.rejects(pending, /CLOSED/); assert.equal(cache.stats(100).entries, 0);
});
test('rejected HTTP status or declared length cancels its body before starting another transfer', async () => {
  for (const status of [403, 200]) {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { canceled = true; } });
    const transport = new FetchChunkTransport({ origin: 'https://ciphertext.example', authorize: async () => 'capability', fetch: async () => new Response(stream, { status, headers: { 'content-length': '999' } }) });
    await assert.rejects(transport.read(request)); assert.equal(canceled, true);
  }
});
test('clock and coordinator reject mismatched configured verifier scope before consuming any command', () => {
  const verifier = new ControlVerifier({ ...scope, sessionId: 'other' }, new Map(), new Set(), new MemoryCheckpointStore());
  assert.equal(verifier.matchesScope(scope), false);
  assert.throws(() => new CoordinatorMonitor(scope, 'program', verifier, async () => null), /SCOPE_MISMATCH/);
  assert.throws(() => new DisciplinedClock(scope, verifier, async () => null, () => 0), /SCOPE_MISMATCH/);
});
