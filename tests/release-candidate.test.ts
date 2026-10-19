import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessReleaseCandidate } from '../src/release-candidate.js';
const sha = 'a'.repeat(40);
const base = {
  sourceSha: sha, artifactSourceSha: sha,
  requiredChecks: ['Engine CI', 'Native audio CI'],
  checks: [
    { name: 'Engine CI', headSha: sha, conclusion: 'success' as const },
    { name: 'Native audio CI', headSha: sha, conclusion: 'success' as const }
  ], reproduciblePackageVerified: true, securityFindingsResolved: true,
  realDeviceQualification: false, productionAuthorization: false
};
test('exact-head reproducible development candidate does not imply production certification', () => {
  const result = assessReleaseCandidate(base);
  assert.equal(result.developmentCandidateVerified, true);
  assert.equal(result.productionReleaseReady, false);
  assert.deepEqual(result.unresolved,
    ['REAL_DEVICE_QUALIFICATION_NOT_VERIFIED', 'PRODUCTION_AUTHORIZATION_MISSING']);
});
test('missing or mismatched required checks and artifact source never become passing evidence', () => {
  const result = assessReleaseCandidate({
    ...base, artifactSourceSha: 'b'.repeat(40),
    checks: [{ name: 'Engine CI', headSha: 'b'.repeat(40), conclusion: 'success' as const }]
  });
  assert.equal(result.developmentCandidateVerified, false);
  assert.equal(result.productionReleaseReady, false);
  assert.ok(result.unresolved.includes('ARTIFACT_SOURCE_MISMATCH'));
  assert.ok(result.unresolved.includes('REQUIRED_CHECK_NOT_VERIFIED:Native audio CI'));
});
test('all actual requirements must match before a production-ready classification', () => {
  assert.equal(assessReleaseCandidate({
    ...base, realDeviceQualification: true, productionAuthorization: true
  }).productionReleaseReady, true);
  assert.throws(() => assessReleaseCandidate({ ...base, requiredChecks: ['Engine CI', 'Engine CI'] }));
  assert.throws(() => assessReleaseCandidate({ ...base, sourceSha: 'latest' }));
});
