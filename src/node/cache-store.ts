import { DatabaseSync } from 'node:sqlite';
import type { CiphertextCacheIndex, CiphertextCacheRecord, CiphertextCacheStore } from '../cache.js';
import { integer, invariant } from '../validation.js';

/** Node-only durable opaque cache. No media keys/private manifests are part of its schema. */
export class SqliteCiphertextCacheStore implements CiphertextCacheStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    invariant(typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0'), 'INVALID_CACHE_DATABASE_PATH');
    this.db = new DatabaseSync(path, { allowExtension: false, enableDoubleQuotedStringLiterals: false });
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS dae_cache_meta (id INTEGER PRIMARY KEY CHECK (id = 1), watermark INTEGER NOT NULL);
      INSERT OR IGNORE INTO dae_cache_meta VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS dae_ciphertext_cache (
        key TEXT PRIMARY KEY, scope_key TEXT NOT NULL, object_id TEXT NOT NULL,
        created INTEGER NOT NULL, expires INTEGER NOT NULL, accessed INTEGER NOT NULL, ciphertext BLOB NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS dae_cache_scope_expiry ON dae_ciphertext_cache(scope_key, expires);`);
  }
  transaction<T>(work: () => T): T {
    invariant(!this.closed, 'CACHE_DATABASE_CLOSED'); this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  observeTime(nowMs: number): void {
    const previous = this.db.prepare('SELECT watermark FROM dae_cache_meta WHERE id = 1').get()!;
    integer(nowMs, Number(previous.watermark)); this.db.prepare('UPDATE dae_cache_meta SET watermark = ? WHERE id = 1').run(nowMs);
  }
  private decode(row: Record<string, string | number | bigint | Uint8Array | null>): CiphertextCacheRecord {
    invariant(typeof row.key === 'string' && typeof row.scope_key === 'string' && typeof row.object_id === 'string' && row.ciphertext instanceof Uint8Array, 'CORRUPT_CACHE_DATABASE');
    const createdAtMs = Number(row.created); const expiresAtMs = Number(row.expires); const accessedAtMs = Number(row.accessed);
    integer(createdAtMs); integer(expiresAtMs, createdAtMs + 1); integer(accessedAtMs, createdAtMs);
    return { key: row.key, scopeKey: row.scope_key, storageObjectId: row.object_id, createdAtMs, expiresAtMs, accessedAtMs, ciphertext: Uint8Array.from(row.ciphertext) };
  }
  get(key: string): CiphertextCacheRecord | undefined { const row = this.db.prepare('SELECT * FROM dae_ciphertext_cache WHERE key = ?').get(key); return row ? this.decode(row) : undefined; }
  list(scopeKey: string): CiphertextCacheIndex[] {
    return this.db.prepare('SELECT key, scope_key, object_id, created, expires, accessed, length(ciphertext) AS bytes FROM dae_ciphertext_cache WHERE scope_key = ?').all(scopeKey).map(row => {
      invariant(typeof row.key === 'string' && typeof row.scope_key === 'string' && typeof row.object_id === 'string', 'CORRUPT_CACHE_DATABASE');
      const createdAtMs = Number(row.created); const expiresAtMs = Number(row.expires); const accessedAtMs = Number(row.accessed); const bytes = Number(row.bytes);
      integer(createdAtMs); integer(expiresAtMs, createdAtMs + 1); integer(accessedAtMs, createdAtMs); integer(bytes, 16, 8 * 1024 * 1024 + 16);
      return { key: row.key, scopeKey: row.scope_key, storageObjectId: row.object_id, createdAtMs, expiresAtMs, accessedAtMs, bytes };
    });
  }
  put(record: CiphertextCacheRecord): void {
    this.db.prepare('INSERT OR REPLACE INTO dae_ciphertext_cache VALUES (?, ?, ?, ?, ?, ?, ?)').run(record.key, record.scopeKey, record.storageObjectId, record.createdAtMs, record.expiresAtMs, record.accessedAtMs, record.ciphertext);
  }
  delete(key: string): void { this.db.prepare('DELETE FROM dae_ciphertext_cache WHERE key = ?').run(key); }
  close(): void { if (this.closed) return; this.db.close(); this.closed = true; }
}
