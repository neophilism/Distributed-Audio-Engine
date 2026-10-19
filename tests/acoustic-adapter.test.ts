import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlVerifier, MemoryCheckpointStore, createControlSigningKey, signControl } from '../src/controls.js';
import { OptInAcousticAdapter } from '../src/acoustic-adapter.js';
import type { AcousticEvidence } from '../src/evidence.js';
import type { ControlBody } from '../src/controls.js';
const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, sessionId: 'session' };
const route = { endpointId: 'endpoint', routeId: 'route', outputId: 'speaker', kind: 'bluetooth-speaker' as const, generation: 1 };
test('opt-in capture cannot start from paired names or without consent, and route transitions revoke', async () => {
  const keys = await createControlSigningKey();
  let now = 100;
  const verifier = new ControlVerifier(scope, new Map([['key', keys.publicKey]]), new Set(['output-evidence']), new MemoryCheckpointStore());
  const adapter = new OptInAcousticAdapter(scope, verifier, async () => ({}), () => now);
  assert.throws(() => adapter.challenge(), /CONSENT_REQUIRED/);
  assert.throws(() => adapter.observeNativeRoute({ origin: 'paired-device', route, observedAtMs: now, playbackSupported: true, capabilities: [] }), /ACTIVE_NATIVE_ROUTE_REQUIRED/);
  adapter.grantConsent(3000);
  adapter.observeNativeRoute({ origin: 'native-active-output', route, observedAtMs: now, playbackSupported: true, capabilities: ['pcm-output'] });
  assert.throws(() => adapter.challenge(), /CONSENT_REQUIRED/);
  adapter.grantConsent(3000);
  assert.equal(adapter.challenge().route.routeId, route.routeId);
  adapter.interrupt();
  assert.throws(() => adapter.challenge(), /CONSENT_REQUIRED/);
  now = 4000;
  assert.throws(() => adapter.grantConsent(4000));
});

test('consent withdrawal during authenticated decoding rejects the in-flight response', async () => {
  const keys = await createControlSigningKey();
  let now = 990;
  let adapter: OptInAcousticAdapter;
  let payload: AcousticEvidence;
  const verifier = new ControlVerifier(scope, new Map([['key', keys.publicKey]]), new Set(['output-evidence']), new MemoryCheckpointStore());
  adapter = new OptInAcousticAdapter(scope, verifier, async () => {
    adapter.revoke();
    return payload;
  }, () => now);
  adapter.observeNativeRoute({ origin: 'native-active-output', route, observedAtMs: now, playbackSupported: true, capabilities: ['pcm-output'] });
  adapter.grantConsent(5000);
  const challenge = adapter.challenge();
  now = 2010;
  payload = {
    nonce: challenge.nonce, evidenceId: 'receipt', scope, route, fromMs: 1000, toMs: 2000,
    measuredDbA: 70, uncertaintyDb: 2, clockUncertaintyMs: 10, calibrationId: 'cal',
    calibrationFromMs: 0, calibrationUntilMs: 5000, consentUntilMs: 5000,
    geometryId: 'reference-1m', weighting: 'A', measurementWindowMs: 1000,
    sourceAttribution: 'validated', origin: 'captured', outputAttribution: 'independent'
  };
  const body: ControlBody = {
    version: '1.0.0', scope, keyId: 'key', algorithm: 'ALG-ED25519', epoch: 1, sequence: 1,
    issuedAtMs: 2000, expiresAtMs: 4000, action: 'output-evidence',
    payloadCiphertextBase64: 'YWJjZA=='
  };
  await assert.rejects(adapter.accept(await signControl(body, keys.privateKey), route, 1), /EVIDENCE_SUPERSEDED/);
  assert.throws(() => adapter.challenge(), /CONSENT_REQUIRED/);
});

test('a consented authenticated capture remains unqualified for real-world field proof', async () => {
  const keys = await createControlSigningKey();
  let now = 990;
  let evidence: AcousticEvidence | undefined;
  const verifier = new ControlVerifier(scope, new Map([['key', keys.publicKey]]), new Set(['output-evidence']), new MemoryCheckpointStore());
  const adapter = new OptInAcousticAdapter(scope, verifier, async () => evidence, () => now);
  adapter.observeNativeRoute({ origin: 'native-active-output', route, observedAtMs: now, playbackSupported: true, capabilities: ['pcm-output'] });
  adapter.grantConsent(5000);
  const challenge = adapter.challenge();
  evidence = {
    nonce: challenge.nonce, evidenceId: 'receipt', scope, route, fromMs: 1000, toMs: 2000,
    measuredDbA: 70, uncertaintyDb: 2, clockUncertaintyMs: 10, calibrationId: 'cal',
    calibrationFromMs: 0, calibrationUntilMs: 5000, consentUntilMs: 5000,
    geometryId: 'reference-1m', weighting: 'A', measurementWindowMs: 1000,
    sourceAttribution: 'validated', origin: 'captured', outputAttribution: 'independent'
  };
  const body: ControlBody = {
    version: '1.0.0', scope, keyId: 'key', algorithm: 'ALG-ED25519', epoch: 1, sequence: 1,
    issuedAtMs: 2000, expiresAtMs: 4000, action: 'output-evidence', payloadCiphertextBase64: 'YWJjZA=='
  };
  now = 2010;
  const accepted = await adapter.accept(await signControl(body, keys.privateKey), route, route.generation);
  assert.equal(accepted.origin, 'captured');
  assert.equal(adapter.routes.snapshot().speakerProven, false);
  assert.equal(adapter.routes.snapshot().acousticQualification, 'unknown');
  assert.equal(accepted.route.outputId, route.outputId);
  await assert.rejects(adapter.accept(await signControl(body, keys.privateKey), route, route.generation));
});
