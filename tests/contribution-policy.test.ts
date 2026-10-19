import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PinnedContributionPolicy } from '../src/contribution-policy.js';
import type { ContributionBand, AcceptedAcousticEvidence } from '../src/evidence.js';
const policy: ContributionBand = {
  version: 'v1', geometryId: 'reference-1m', measurementWindowMs: 1000,
  minimumDbA: 60, safetyCeilingDbA: 80, maximumUncertaintyDb: 3,
  maximumClockUncertaintyMs: 20, allowedKinds: ['bluetooth-speaker']
};
test('policy is deeply pinned and cannot be widened by caller mutations', () => {
  const input = { ...policy, allowedKinds: ['bluetooth-speaker'] as ('bluetooth-speaker' | 'wired-speaker')[] };
  const pinned = new PinnedContributionPolicy(input);
  input.minimumDbA = 0;
  input.allowedKinds.push('wired-speaker');
  assert.deepEqual(pinned.snapshot(), policy);
  const copy = pinned.snapshot();
  assert.equal(copy.allowedKinds.length, 1);
  assert.throws(() => pinned.evaluate({} as AcceptedAcousticEvidence, { fromMs: 1, toMs: 2 }), /UNAUTHENTICATED_EVIDENCE/);
});
test('reversed and unsafe bounds and unsupported route kinds reject at configuration time', () => {
  assert.throws(() => new PinnedContributionPolicy({ ...policy, minimumDbA: 81 }), /INVALID/);
  assert.throws(() => new PinnedContributionPolicy({ ...policy, maximumUncertaintyDb: -1 }), /INVALID/);
  assert.throws(() => new PinnedContributionPolicy({ ...policy, allowedKinds: ['headphones'] as never }), /INVALID_CONTRIBUTION_ROUTES/);
  assert.throws(() => new PinnedContributionPolicy({ ...policy, allowedKinds: ['bluetooth-speaker', 'bluetooth-speaker'] }), /INVALID_CONTRIBUTION_ROUTES/);
});
