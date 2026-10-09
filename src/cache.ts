import type { ApplicationScope } from './contracts.js';
import type { ChunkRequest, CiphertextChunkTransport } from './delivery.js';
import { validateChunkRequest } from './delivery.js';
import { canonicalJson, identifier, integer, invariant } from './validation.js';

export interface CacheScope { tenantId: string; application: ApplicationScope }
export interface CiphertextCacheRecord {
  key: string; scopeKey: string; storageObjectId: string;
  createdAtMs: number; expiresAtMs: number; accessedAtMs: number; ciphertext: Uint8Array;
}
export interface CiphertextCacheIndex extends Omit<CiphertextCacheRecord, 'ciphertext'> { bytes: number }
/** All operations inside transaction must be atomic, including eviction and the time watermark. */
export interface CiphertextCacheStore {
  transaction<T>(work: () => T): T;
  observeTime(nowMs: number): void;
  get(key: string): CiphertextCacheRecord | undefined;
  list(scopeKey: string): CiphertextCacheIndex[];
  put(record: CiphertextCacheRecord): void;
  delete(key: string): void;
}
function copy(record: CiphertextCacheRecord): CiphertextCacheRecord { return { ...record, ciphertext: Uint8Array.from(record.ciphertext) }; }
export class MemoryCiphertextCacheStore implements CiphertextCacheStore {
  private records = new Map<string, CiphertextCacheRecord>();
  private watermark = 0;
  transaction<T>(work: () => T): T {
    const prior = new Map(this.records); const time = this.watermark;
    try { return work(); } catch (error) { this.records = prior; this.watermark = time; throw error; }
  }
  observeTime(nowMs: number): void { integer(nowMs, this.watermark); this.watermark = nowMs; }
  get(key: string): CiphertextCacheRecord | undefined { const value = this.records.get(key); return value ? copy(value) : undefined; }
  list(scopeKey: string): CiphertextCacheIndex[] { return [...this.records.values()].filter(r => r.scopeKey === scopeKey).map(({ ciphertext, ...metadata }) => ({ ...metadata, bytes: ciphertext.length })); }
  put(record: CiphertextCacheRecord): void { this.records.set(record.key, copy(record)); }
  delete(key: string): void { this.records.delete(key); }
}
export interface CiphertextCacheLimits { maxBytes: number; maxEntries: number; maxRetentionMs: number }
/** Ciphertext-only cache policy. It grants no recipient or playback authority. */
export class EndpointCiphertextCache {
  private readonly scopeKey: string;
  private readonly scope: CacheScope;
  private readonly limits: CiphertextCacheLimits;
  constructor(private readonly store: CiphertextCacheStore, scope: CacheScope, limits: CiphertextCacheLimits) {
    identifier(scope.tenantId); invariant(scope.application === 'scenesignal' || scope.application === 'distributed-radio', 'INVALID_APPLICATION');
    integer(limits.maxBytes, 16, 128 * 1024 * 1024); integer(limits.maxEntries, 1, 8192); integer(limits.maxRetentionMs, 1, 30 * 24 * 60 * 60 * 1000);
    this.scope = { ...scope }; this.scopeKey = canonicalJson(this.scope); this.limits = { ...limits };
  }
  get maxEntryBytes(): number { return this.limits.maxBytes; }
  get maxRetentionMs(): number { return this.limits.maxRetentionMs; }
  private key(request: ChunkRequest): string {
    validateChunkRequest(request);
    invariant(request.tenantId === this.scope.tenantId && request.application === this.scope.application, 'CACHE_SCOPE_MISMATCH');
    return canonicalJson(request);
  }
  private purge(nowMs: number): void {
    for (const record of this.store.list(this.scopeKey)) if (record.expiresAtMs <= nowMs) this.store.delete(record.key);
  }
  get(request: ChunkRequest, nowMs: number): Uint8Array | undefined {
    const key = this.key(request); integer(nowMs);
    return this.store.transaction(() => {
      this.store.observeTime(nowMs); this.purge(nowMs);
      const record = this.store.get(key); if (!record) return undefined;
      invariant(record.scopeKey === this.scopeKey && record.storageObjectId === request.storageObjectId && record.ciphertext.length === request.expectedBytes, 'CORRUPT_CACHE_RECORD');
      this.store.put({ ...record, accessedAtMs: nowMs }); return Uint8Array.from(record.ciphertext);
    });
  }
  put(request: ChunkRequest, ciphertext: Uint8Array, nowMs: number, expiresAtMs: number): void {
    const key = this.key(request); integer(nowMs); integer(expiresAtMs, nowMs + 1, nowMs + this.limits.maxRetentionMs);
    invariant(ciphertext.length === request.expectedBytes && ciphertext.length <= this.limits.maxBytes, 'CACHE_ENTRY_TOO_LARGE_OR_WRONG_LENGTH');
    const local = Uint8Array.from(ciphertext);
    this.store.transaction(() => {
      this.store.observeTime(nowMs); this.purge(nowMs);
      const existing = this.store.get(key);
      if (existing) invariant(existing.ciphertext.length === local.length && existing.ciphertext.every((value, i) => value === local[i]), 'CACHE_CIPHERTEXT_CONFLICT');
      this.store.delete(key);
      const records = this.store.list(this.scopeKey).sort((a, b) => a.accessedAtMs - b.accessedAtMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      let used = records.reduce((total, r) => total + r.bytes, 0); let count = records.length;
      for (const record of records) {
        if (used + local.length <= this.limits.maxBytes && count + 1 <= this.limits.maxEntries) break;
        this.store.delete(record.key); used -= record.bytes; count--;
      }
      this.store.put({ key, scopeKey: this.scopeKey, storageObjectId: request.storageObjectId, createdAtMs: existing?.createdAtMs ?? nowMs, expiresAtMs: existing ? Math.min(expiresAtMs, existing.expiresAtMs) : expiresAtMs, accessedAtMs: nowMs, ciphertext: local });
    });
  }
  invalidate(request: ChunkRequest): void { const key = this.key(request); this.store.transaction(() => this.store.delete(key)); }
  deleteObject(storageObjectId: string): number {
    identifier(storageObjectId);
    return this.store.transaction(() => { let count = 0; for (const r of this.store.list(this.scopeKey)) if (r.storageObjectId === storageObjectId) { this.store.delete(r.key); count++; } return count; });
  }
  stats(nowMs: number): { entries: number; bytes: number } {
    integer(nowMs); return this.store.transaction(() => { this.store.observeTime(nowMs); this.purge(nowMs); const records = this.store.list(this.scopeKey); return { entries: records.length, bytes: records.reduce((sum, r) => sum + r.bytes, 0) }; });
  }
}
interface PendingRead { controller: AbortController; promise: Promise<Uint8Array>; waiters: number }
/** Shared downloads stay ciphertext-only; one canceled listener cannot cancel other listeners. */
export class CachingChunkTransport implements CiphertextChunkTransport {
  private readonly pending = new Map<string, PendingRead>();
  private closed = false;
  constructor(private readonly cache: EndpointCiphertextCache, private readonly upstream: CiphertextChunkTransport, private readonly nowUnixMs: () => number, private readonly retentionMs: number) { integer(retentionMs, 1, cache.maxRetentionMs); }
  async read(request: ChunkRequest, signal?: AbortSignal): Promise<Uint8Array> {
    invariant(!this.closed && !signal?.aborted, 'CACHE_TRANSPORT_CLOSED_OR_ABORTED');
    const local = { ...request }; const cached = this.cache.get(local, this.nowUnixMs()); if (cached) return cached;
    const key = canonicalJson(local); let entry = this.pending.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = (async () => {
        const result = await this.upstream.read(local, controller.signal);
        invariant(!this.closed && !controller.signal.aborted, 'CACHE_TRANSPORT_CLOSED_OR_ABORTED');
        invariant(result.length === local.expectedBytes, 'CIPHERTEXT_LENGTH_MISMATCH'); const snapshot = Uint8Array.from(result);
        const now = this.nowUnixMs(); if (snapshot.length <= this.cache.maxEntryBytes) this.cache.put(local, snapshot, now, now + this.retentionMs);
        return snapshot;
      })();
      entry = { controller, promise, waiters: 0 }; this.pending.set(key, entry);
      const created = entry; const cleanup = () => { if (this.pending.get(key) === created) this.pending.delete(key); };
      void promise.then(cleanup, cleanup);
    }
    entry.waiters++;
    let onAbort: (() => void) | undefined;
    try {
      const canceled = new Promise<never>((_resolve, reject) => { if (signal) { onAbort = () => reject(new Error('DELIVERY_ABORTED')); signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort(); } });
      const result = await Promise.race([entry.promise, canceled]);
      invariant(!this.closed && !signal?.aborted, 'CACHE_TRANSPORT_CLOSED_OR_ABORTED'); return Uint8Array.from(result);
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      if (--entry.waiters === 0) { entry.controller.abort(); if (this.pending.get(key) === entry) this.pending.delete(key); }
    }
  }
  async invalidate(request: ChunkRequest): Promise<void> { this.cache.invalidate(request); await this.upstream.invalidate?.(request); }
  close(): void { this.closed = true; for (const entry of this.pending.values()) entry.controller.abort(); this.pending.clear(); }
}
