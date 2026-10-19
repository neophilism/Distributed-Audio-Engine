import type { AtomicEvidenceClaimStore } from './evidence-replay.js';
import { invariant, integer } from './validation.js';

export interface EvidenceSqlClient {
  query(sql: string, params: readonly (string | number)[]): Promise<{ rowCount: number | null }>;
}
/** PostgreSQL adapter. Apply migrations/001_evidence_replay.sql before use. */
export class PostgresEvidenceClaimStore implements AtomicEvidenceClaimStore {
  constructor(private readonly client: EvidenceSqlClient) {
    invariant(client && typeof client.query === 'function', 'EVIDENCE_DB_REQUIRED');
  }
  async claimOnce(key: string, expiresAtMs: number): Promise<boolean> {
    invariant(typeof key === 'string' && key.length > 0 && key.length <= 4096, 'INVALID_EVIDENCE_KEY');
    integer(expiresAtMs, 1);
    // Do not delete/expire unique receipts automatically; accounting replay
    // protection persists until explicitly reconciled under owner retention policy.
    const result = await this.client.query(
      'INSERT INTO dae_evidence_replay (claim_key, submitted_expiry_ms) VALUES ($1, $2) ON CONFLICT (claim_key) DO NOTHING',
      [key, expiresAtMs]
    );
    invariant(result && (result.rowCount === 0 || result.rowCount === 1), 'EVIDENCE_DB_RESULT_INVALID');
    return result.rowCount === 1;
  }
}
