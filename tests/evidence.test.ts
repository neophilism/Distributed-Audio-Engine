import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlVerifier, MemoryCheckpointStore, createControlSigningKey, signControl } from '../src/controls.js';
import { OutputEvidenceEndpoint, evaluateContribution, contributionCoverage } from '../src/evidence.js';
import { OutputLifecycle } from '../src/output-lifecycle.js';
import type { AcousticEvidence, ContributionBand, AcceptedAcousticEvidence } from '../src/evidence.js';
import type { ControlBody } from '../src/controls.js';
const scope = { tenantId: 't', application: 'distributed-radio' as const, sessionId: 's' };
const route = { endpointId: 'e', routeId: 'r', outputId: 'o', kind: 'bluetooth-speaker' as const, generation: 1 };
const policy: ContributionBand = { version: 'v1', geometryId: 'reference-1m', measurementWindowMs: 1000, minimumDbA: 60, safetyCeilingDbA: 80, maximumUncertaintyDb: 3, maximumClockUncertaintyMs: 20, allowedKinds: ['bluetooth-speaker'] };
async function fixture(changes: Partial<AcousticEvidence> = {}) {
  const keys = await createControlSigningKey(); let now = 990; let payload: unknown;
  const verifier = new ControlVerifier(scope, new Map([['k', keys.publicKey]]), new Set(['output-evidence']), new MemoryCheckpointStore());
  const endpoint = new OutputEvidenceEndpoint(scope, verifier, async () => payload, () => now);
  const challenge = endpoint.challenge(route, 5000); now = 2010;
  payload = { nonce: challenge.nonce, evidenceId: 'receipt', scope, route, fromMs: 1000, toMs: 2000, measuredDbA: 70, uncertaintyDb: 2, clockUncertaintyMs: 10, calibrationId: 'cal', calibrationFromMs: 0, calibrationUntilMs: 10000, consentUntilMs: 5000, geometryId: 'reference-1m', weighting: 'A', measurementWindowMs: 1000, sourceAttribution: 'validated', origin: 'captured', outputAttribution: 'independent', ...changes };
  const body: ControlBody = { version: '1.0.0', scope, keyId: 'k', algorithm: 'ALG-ED25519', epoch: 1, sequence: 1, issuedAtMs: 2000, expiresAtMs: 4000, action: 'output-evidence', payloadCiphertextBase64: 'YWJjZA==' };
  return { endpoint, keys, body, signed: await signControl(body, keys.privateKey), change: (value: unknown) => { payload = value; }, setNow: (value: number) => { now = value; } };
}
test('authenticated calibrated decision trims uncertainty and never supplies field certification', async () => {
  const f = await fixture(); const e = await f.endpoint.accept(f.signed); const result = evaluateContribution(e, policy, { fromMs: 0, toMs: 3000 });
  assert.deepEqual(result, { qualified: true, scope, evidenceId: 'receipt', outputId: 'o', fromMs: 1010, toMs: 1990, conservativeDbA: 68, upperDbA: 72, policyVersion: 'v1', assurance: 'authenticated-verifier-decision', fieldValidated: false });
  assert.throws(() => { (e.route as { kind: string }).kind = 'headphones'; });
  await assert.rejects(f.endpoint.accept(f.signed));
  assert.throws(() => evaluateContribution({ ...e } as AcceptedAcousticEvidence, policy, { fromMs: 0, toMs: 3000 }));
});
test('headphones, simulated/aggregate evidence, uncertain levels and stale calibration qualify no output', async () => {
  for (const changes of [{ route: { ...route, kind: 'headphones' as const } }, { origin: 'simulated' as const }, { outputAttribution: 'aggregate' as const }, { sourceAttribution: 'inconclusive' as const }, { measuredDbA: 79 }, { calibrationUntilMs: 900 }]) {
    const f = await fixture(changes);
    if ('route' in changes) await assert.rejects(f.endpoint.accept(f.signed));
    else { const e = await f.endpoint.accept(f.signed); assert.equal(evaluateContribution(e, policy, { fromMs: 0, toMs: 3000 }).qualified, false); }
  }
});
test('forgery, cross-route, unknown fields, late decoding and withdrawal reject before qualification', async () => {
  const wrong = await createControlSigningKey(); const f = await fixture(); await assert.rejects(f.endpoint.accept(await signControl(f.body, wrong.privateKey)));
  const g = await fixture({ route: { ...route, generation: 2 } }); await assert.rejects(g.endpoint.accept(g.signed));
  const h = await fixture(); const pending = h.endpoint.accept(h.signed); h.endpoint.invalidate(); await assert.rejects(pending);
  const j = await fixture(); j.setNow(6000); await assert.rejects(j.endpoint.accept(j.signed));
  const k = await fixture(); k.change({ rawAmbientAudio: 'private' }); await assert.rejects(k.endpoint.accept(k.signed));
});
test('overlapping clients sharing a physical output count only the union of its intervals', async () => {
  const f = await fixture(); const i = evaluateContribution(await f.endpoint.accept(f.signed), policy, { fromMs: 0, toMs: 3000 });
  assert.deepEqual(contributionCoverage([i, i]), [{ outputId: 'o', durationMs: 980 }]);
});
test('native active-route generations interrupt old playback and invalidate evidence immediately', () => {
  let invalidations = 0; const lifecycle = new OutputLifecycle(() => { invalidations++; });
  lifecycle.active(route, true); lifecycle.requireCurrent(route); assert.equal(lifecycle.snapshot().state, 'active');
  lifecycle.interrupt(); assert.throws(() => lifecycle.requireCurrent(route)); assert.throws(() => lifecycle.active(route, true));
  lifecycle.active({ ...route, generation: 3 }, true); lifecycle.disconnect(); assert.equal(invalidations, 4);
});

test('measurements must follow the challenge and calibration must cover the full uncertain window', async () => {
  const before = await fixture({ fromMs: 900, toMs: 1900 }); await assert.rejects(before.endpoint.accept(before.signed), /TIME_OR_CONSENT/);
  const mismatch = await fixture({ measurementWindowMs: 500 }); await assert.rejects(mismatch.endpoint.accept(mismatch.signed), /WINDOW_MISMATCH/);
  for (const changes of [{ calibrationFromMs: 1000 }, { calibrationUntilMs: 2000 }]) {
    const f = await fixture(changes), e = await f.endpoint.accept(f.signed);
    assert.deepEqual(evaluateContribution(e, policy, { fromMs: 1100, toMs: 1900 }), { qualified: false, reason: 'CALIBRATION_DOES_NOT_COVER_WINDOW' });
  }
});
test('coverage rejects copied results, mutations and mixed policy contexts', async () => {
  const f = await fixture(), e = await f.endpoint.accept(f.signed);
  const first = evaluateContribution(e, policy, { fromMs: 0, toMs: 3000 });
  const second = evaluateContribution(e, { ...policy, version: 'v2' }, { fromMs: 0, toMs: 3000 });
  assert.throws(() => contributionCoverage([{ ...first }])); assert.throws(() => contributionCoverage([first, second]), /MIXED_CONTRIBUTION_CONTEXT/);
  assert.throws(() => Object.assign(first, { toMs: 99999 }));
});
test('failed native invalidation cannot leave an old active route usable', () => {
  let fail = false; const lifecycle = new OutputLifecycle(() => { if (fail) throw Error('sink failed'); });
  lifecycle.active(route, true); fail = true; assert.throws(() => lifecycle.interrupt()); assert.throws(() => lifecycle.requireCurrent(route));
  assert.throws(() => lifecycle.active({ ...route, generation: 3 }, true)); assert.equal(lifecycle.snapshot().state, 'unavailable');
});
