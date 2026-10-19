import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresEvidenceClaimStore } from '../src/evidence-replay-postgres.js';
test('parameterized atomic insert returns first claim only', async () => {
  const seen = new Set<string>();
  const sqls: string[] = [];
  const adapter = new PostgresEvidenceClaimStore({
    query: async (sql, params) => {
      sqls.push(sql);
      assert.deepEqual(params, ['scope/evidence', 9999]);
      const key = params[0] as string;
      if (seen.has(key)) return { rowCount: 0 };
      seen.add(key); return { rowCount: 1 };
    }
  });
  assert.equal(await adapter.claimOnce('scope/evidence', 9999), true);
  assert.equal(await adapter.claimOnce('scope/evidence', 9999), false);
  assert.match(sqls[0]!, /ON CONFLICT \(claim_key\) DO NOTHING/);
  assert.equal(sqls.length, 2);
});
test('SQL errors and malformed row counts fail closed', async () => {
  const bad = new PostgresEvidenceClaimStore({ query: async () => ({ rowCount: 2 }) });
  await assert.rejects(bad.claimOnce('key', 1000), /EVIDENCE_DB_RESULT_INVALID/);
  const down = new PostgresEvidenceClaimStore({ query: async () => { throw new Error('storage unavailable'); } });
  await assert.rejects(down.claimOnce('key', 1000), /storage unavailable/);
});
