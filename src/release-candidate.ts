import { invariant } from './validation.js';

/** Advisory release evidence summary, never an authorization to publish or deploy. */
export interface ReleaseCandidateEvidence {
  sourceSha: string;
  artifactSourceSha: string | null;
  checks: readonly { name: string; headSha: string; conclusion: 'success' | 'failure' | 'pending' | 'missing' }[];
  requiredChecks: readonly string[];
  reproduciblePackageVerified: boolean;
  securityFindingsResolved: boolean;
  realDeviceQualification: boolean;
  productionAuthorization: boolean;
}
export interface ReleaseCandidateAssessment {
  developmentCandidateVerified: boolean;
  productionReleaseReady: boolean;
  unresolved: readonly string[];
}
export function assessReleaseCandidate(evidence: ReleaseCandidateEvidence): ReleaseCandidateAssessment {
  invariant(evidence && typeof evidence === 'object' &&
    /^[0-9a-f]{40}$/.test(evidence.sourceSha), 'INVALID_RELEASE_SOURCE_SHA');
  invariant(Array.isArray(evidence.requiredChecks) && evidence.requiredChecks.length > 0 &&
    evidence.requiredChecks.every(v => typeof v === 'string' && v.length > 0) &&
    new Set(evidence.requiredChecks).size === evidence.requiredChecks.length,
    'INVALID_REQUIRED_RELEASE_CHECKS');
  invariant(Array.isArray(evidence.checks), 'INVALID_RELEASE_CHECKS');
  const unresolved: string[] = [];
  if (evidence.artifactSourceSha !== evidence.sourceSha) unresolved.push('ARTIFACT_SOURCE_MISMATCH');
  for (const name of evidence.requiredChecks) {
    const reports = evidence.checks.filter(c => c && c.name === name);
    if (reports.length !== 1 || reports[0]!.headSha !== evidence.sourceSha ||
        reports[0]!.conclusion !== 'success') unresolved.push('REQUIRED_CHECK_NOT_VERIFIED:' + name);
  }
  if (evidence.reproduciblePackageVerified !== true) unresolved.push('REPRODUCIBLE_PACKAGE_NOT_VERIFIED');
  if (evidence.securityFindingsResolved !== true) unresolved.push('SECURITY_FINDINGS_UNRESOLVED');
  const developmentCandidateVerified = unresolved.length === 0;
  if (evidence.realDeviceQualification !== true) unresolved.push('REAL_DEVICE_QUALIFICATION_NOT_VERIFIED');
  if (evidence.productionAuthorization !== true) unresolved.push('PRODUCTION_AUTHORIZATION_MISSING');
  return Object.freeze({
    developmentCandidateVerified,
    productionReleaseReady: unresolved.length === 0,
    unresolved: Object.freeze(unresolved)
  });
}
