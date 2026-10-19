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
