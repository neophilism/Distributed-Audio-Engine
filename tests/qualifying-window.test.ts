import { ControlVerifier, MemoryCheckpointStore, createControlSigningKey, signControl } from '../src/controls.js';
import type { ControlBody } from '../src/controls.js';
import { OutputEvidenceEndpoint } from '../src/evidence.js';
import type { AcousticEvidence } from '../src/evidence.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCurrentWindow } from '../src/qualifying-window.js';
import type { AcceptedAcousticEvidence, ContributionBand } from '../src/evidence.js';
const route = { endpointId: 'endpoint', routeId: 'route', outputId: 'speaker', kind: 'bluetooth-speaker' as const, generation: 2 };
const evidence = { route, consentUntilMs: 3000, toMs: 2000 } as AcceptedAcousticEvidence;
const policy = {} as ContributionBand;
const profile = { state: 'active' as const, generation: 2, route, playbackSupported: true, capabilities: [],
  speakerProven: false as const, acousticQualification: 'unknown' as const };
test('missing native-active output never qualifies a window', () => {
  assert.deepEqual(evaluateCurrentWindow(evidence, policy, { fromMs: 1000, toMs: 2000 },
    { ...profile, state: 'interrupted' }, 2500), { qualified: false, reason: 'OUTPUT_NOT_ACTIVE' });
  assert.deepEqual(evaluateCurrentWindow(evidence, policy, { fromMs: 1000, toMs: 2000 },
    { ...profile, playbackSupported: false }, 2500), { qualified: false, reason: 'OUTPUT_NOT_ACTIVE' });
});
test('route generation rollover, withdrawn consent and future windows are rejected', () => {
  const bounds = { fromMs: 1000, toMs: 2000 };
  assert.deepEqual(evaluateCurrentWindow(evidence, policy, bounds, { ...profile, generation: 3 }, 2500),
    { qualified: false, reason: 'ROUTE_CHANGED' });
  assert.deepEqual(evaluateCurrentWindow(evidence, policy, bounds, profile, 3000),
    { qualified: false, reason: 'CONSENT_EXPIRED' });
  assert.deepEqual(evaluateCurrentWindow(evidence, policy, bounds, profile, 1999),
    { qualified: false, reason: 'FUTURE_WINDOW' });
});

test('authenticated captured evidence yields only bounded non-field-qualified interval', async () => {
  const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, sessionId: 'session' };
  const keys = await createControlSigningKey();
  let now = 990;
  let payload: AcousticEvidence | undefined;
  const verifier = new ControlVerifier(scope, new Map([['key', keys.publicKey]]),
    new Set(['output-evidence']), new MemoryCheckpointStore());
  const endpoint = new OutputEvidenceEndpoint(scope, verifier, async () => payload, () => now);
  const challenge = endpoint.challenge(route, 5000);
  now = 2010;
  payload = {
    nonce: challenge.nonce, evidenceId: 'evidence', scope, route, fromMs: 1000, toMs: 2000,
    measuredDbA: 70, uncertaintyDb: 2, clockUncertaintyMs: 10, calibrationId: 'cal',
    calibrationFromMs: 0, calibrationUntilMs: 5000, consentUntilMs: 5000,
    geometryId: 'geometry', weighting: 'A', measurementWindowMs: 1000,
    sourceAttribution: 'validated', origin: 'captured', outputAttribution: 'independent'
  };
  const body: ControlBody = {
    version: '1.0.0', scope, keyId: 'key', algorithm: 'ALG-ED25519', epoch: 1, sequence: 1,
    issuedAtMs: 2000, expiresAtMs: 4000, action: 'output-evidence', payloadCiphertextBase64: 'YWJjZA=='
  };
  const accepted = await endpoint.accept(await signControl(body, keys.privateKey));
  const band: ContributionBand = {
    version: 'policy', geometryId: 'geometry', measurementWindowMs: 1000, minimumDbA: 60,
    safetyCeilingDbA: 80, maximumUncertaintyDb: 3, maximumClockUncertaintyMs: 20,
    allowedKinds: ['bluetooth-speaker']
  };
  const result = evaluateCurrentWindow(accepted, band, { fromMs: 1000, toMs: 2000 }, profile, now);
  assert.equal(result.qualified, true);
  if (result.qualified) {
    assert.equal(result.fieldValidated, false);
    assert.equal(result.fromMs, 1010);
    assert.equal(result.toMs, 1990);
  }
});
