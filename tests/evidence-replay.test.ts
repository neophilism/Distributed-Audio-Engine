import { ControlVerifier, MemoryCheckpointStore, createControlSigningKey, signControl } from '../src/controls.js';
import type { ControlBody } from '../src/controls.js';
import { OutputEvidenceEndpoint, evaluateContribution } from '../src/evidence.js';
import type { AcousticEvidence, ContributionBand } from '../src/evidence.js';
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

test('one authenticated qualifying receipt can be atomically claimed only once', async () => {
  const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, sessionId: 'session' };
  const route = { endpointId: 'endpoint', routeId: 'route', outputId: 'speaker',
    kind: 'bluetooth-speaker' as const, generation: 1 };
  const keys = await createControlSigningKey();
  let now = 990;
  let payload: AcousticEvidence | undefined;
  const verifier = new ControlVerifier(scope, new Map([['key', keys.publicKey]]),
    new Set(['output-evidence']), new MemoryCheckpointStore());
  const endpoint = new OutputEvidenceEndpoint(scope, verifier, async () => payload, () => now);
  const challenge = endpoint.challenge(route, 5000);
  payload = {
    nonce: challenge.nonce, evidenceId: 'receipt', scope, route, fromMs: 1000, toMs: 2000,
    measuredDbA: 70, uncertaintyDb: 2, clockUncertaintyMs: 10,
    calibrationId: 'cal', calibrationFromMs: 0, calibrationUntilMs: 5000,
    consentUntilMs: 5000, geometryId: 'reference', weighting: 'A',
    measurementWindowMs: 1000, sourceAttribution: 'validated',
    origin: 'captured', outputAttribution: 'independent'
  };
  const body: ControlBody = {
    version: '1.0.0', scope, keyId: 'key', algorithm: 'ALG-ED25519',
    epoch: 1, sequence: 1, issuedAtMs: 2000, expiresAtMs: 4000,
    action: 'output-evidence', payloadCiphertextBase64: 'YWJjZA=='
  };
  now = 2010;
  const signed = await endpoint.accept(await signControl(body, keys.privateKey));
  const policy: ContributionBand = {
    version: 'v1', geometryId: 'reference', measurementWindowMs: 1000,
    minimumDbA: 60, safetyCeilingDbA: 80, maximumUncertaintyDb: 3,
    maximumClockUncertaintyMs: 20, allowedKinds: ['bluetooth-speaker']
  };
  const qualifying = evaluateContribution(signed, policy, { fromMs: 1000, toMs: 2000 });
  assert.equal(qualifying.qualified, true);
  const claims = new Set<string>();
  const gate = new SignedEvidenceReplayGate({
    claimOnce: async key => { if (claims.has(key)) return false; claims.add(key); return true; }
  }, () => now);
  assert.equal(await gate.consume(qualifying, 3000), true);
  assert.equal(await gate.consume(qualifying, 3000), false);
  assert.equal(claims.size, 1);
  await assert.rejects(gate.consume(qualifying, 2010));
});
