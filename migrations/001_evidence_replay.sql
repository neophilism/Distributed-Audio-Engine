-- Durable anti-abuse claim key for DAE-20. No implicit expiry/deletion.
-- Use the same transaction/claim uniqueness boundary as the consuming entitlement ledger.
CREATE TABLE IF NOT EXISTS dae_evidence_replay (
  claim_key text PRIMARY KEY,
  submitted_expiry_ms bigint NOT NULL CHECK (submitted_expiry_ms > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
