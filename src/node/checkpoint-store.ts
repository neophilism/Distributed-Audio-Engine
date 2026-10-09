import { DatabaseSync } from 'node:sqlite';
import type { CheckpointStore, ControlCheckpoint } from '../controls.js';
import { canonicalJson, parseCanonicalJson, identifier, integer, invariant } from '../validation.js';

function validateScopeKey(scopeKey: string): void {
  invariant(typeof scopeKey === 'string' && scopeKey.length <= 1024, 'INVALID_CHECKPOINT_SCOPE');
  const scope: unknown = parseCanonicalJson(scopeKey);
  invariant(scope && typeof scope === 'object' && Object.keys(scope).sort().join(',') === 'application,sessionId,tenantId', 'INVALID_CHECKPOINT_SCOPE');
  const fields = scope as Record<string, unknown>; identifier(fields.tenantId); identifier(fields.sessionId);
  invariant(fields.application === 'scenesignal' || fields.application === 'distributed-radio', 'INVALID_APPLICATION');
  invariant(canonicalJson(scope) === scopeKey, 'NON_CANONICAL_CHECKPOINT_SCOPE');
}
function validateCheckpoint(checkpoint: ControlCheckpoint): void {
  invariant(checkpoint && Object.keys(checkpoint).sort().join(',') === 'epoch,sequence', 'INVALID_CHECKPOINT');
  integer(checkpoint.epoch, 1); integer(checkpoint.sequence, 1);
}
/** Durable compare-and-set for replay counters. Contains routing metadata, never control payloads/keys. */
export class SqliteCheckpointStore implements CheckpointStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    invariant(typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0'), 'INVALID_CHECKPOINT_DATABASE_PATH');
    this.db = new DatabaseSync(path, { allowExtension: false, enableDoubleQuotedStringLiterals: false });
    this.db.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS dae_control_checkpoints (
        scope_key TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK (epoch > 0), sequence INTEGER NOT NULL CHECK (sequence > 0)
      ) STRICT;`);
  }
  read(scopeKey: string): ControlCheckpoint | undefined {
    invariant(!this.closed, 'CHECKPOINT_DATABASE_CLOSED'); validateScopeKey(scopeKey);
    const row = this.db.prepare('SELECT epoch, sequence FROM dae_control_checkpoints WHERE scope_key = ?').get(scopeKey);
    if (!row) return undefined;
    const value = { epoch: Number(row.epoch), sequence: Number(row.sequence) }; validateCheckpoint(value); return value;
  }
  compareAndSet(scopeKey: string, expected: ControlCheckpoint | undefined, next: ControlCheckpoint): boolean {
    invariant(!this.closed, 'CHECKPOINT_DATABASE_CLOSED'); validateScopeKey(scopeKey); validateCheckpoint(next); if (expected) validateCheckpoint(expected);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.read(scopeKey);
      if (canonicalJson(current ?? null) !== canonicalJson(expected ?? null)) { this.db.exec('ROLLBACK'); return false; }
      const valid = current ? next.epoch > current.epoch ? next.sequence === 1 : next.epoch === current.epoch && next.sequence === current.sequence + 1 : next.sequence === 1;
      if (!valid) { this.db.exec('ROLLBACK'); return false; }
      this.db.prepare('INSERT OR REPLACE INTO dae_control_checkpoints VALUES (?, ?, ?)').run(scopeKey, next.epoch, next.sequence);
      this.db.exec('COMMIT'); return true;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { if (this.closed) return; this.db.close(); this.closed = true; }
}
