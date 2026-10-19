import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignedEvidenceReplayGate } from '../src/evidence-replay.js';
import type { QualifyingInterval } from '../src/evidence.js';
test('forged or copied qualification cannot be accepted into replay ledger', async () => {
  let claims = 0;
  const gate = new SignedEvidenceReplayGate({
    claimOnce: async () => { claims++; return true; }
  }, () => 100);
  await assert.rejects(gate.consume({
    qualified: true, scope: { tenantId: 'tenant', application: 'distributed-radio', sessionId: 'session' },
    evidenceId: 'fake', outputId: 'speaker', fromMs: 1, toMs: 2,
    conservativeDbA: 70, upperDbA: 72, policyVersion: 'v1',
    assurance: 'authenticated-verifier-decision', fieldValidated: false
  }, 1000), /UNAUTHENTICATED_QUALIFYING_INTERVAL/);
  assert.equal(claims, 0);
  assert.equal(await gate.consume({ qualified: false, reason: 'NO_CERTAIN_INTERVAL' }, 1000), false);
  assert.equal(claims, 0);
});
test('missing atomic replay store fails closed at construction', () => {
  assert.throws(() => new SignedEvidenceReplayGate({} as never, () => 100), /REPLAY_ADAPTER_REQUIRED/);
});
