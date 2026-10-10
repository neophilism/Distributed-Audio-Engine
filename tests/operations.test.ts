import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OperationsEvidenceAcceptor, assessOperationsAssurance } from '../src/operations.js';
import type { OperationsEvidenceBinding, OperationsEvidenceKind, OperationsEvidenceRecord } from '../src/operations.js';

const now = 2_000;
const scope = { tenantId: 'tenant', application: 'distributed-audio-engine' as const, componentId: 'portable-core' };
const subjectArtifactDigest = 'sha256:' + 'a'.repeat(64);
const standardCommit = 'b'.repeat(40);
const binding: OperationsEvidenceBinding = { scope, subjectArtifactDigest, standardCommit, maximumAgeMs: 1_000 };
const verified = new Set<string>();
const verifier = { async verify(record: Readonly<OperationsEvidenceRecord>) { return verified.has(record.evidenceDigest); } };
function evidence(kind: OperationsEvidenceKind, changes: Partial<OperationsEvidenceRecord> = {}): OperationsEvidenceRecord {
  const index = ['retention-policy', 'deletion-drill', 'restore-drill', 'independent-security-review'].indexOf(kind) + 1;
  const value: OperationsEvidenceRecord = {
    version: '1.0.0', evidenceId: `evidence-${index}`, kind, scope,
    subjectArtifactDigest, evidenceDigest: 'sha256:' + String(index).repeat(64), standardCommit,
    environment: 'production', observedAtMs: 1_500, expiresAtMs: 3_000,
    subjectId: 'release-owner', verifierId: kind === 'independent-security-review' ? 'independent-reviewer' : 'operations-verifier', result: 'passed',
    ...changes,
  };
  verified.add(value.evidenceDigest); return value;
}
const assessmentBinding = { scope, subjectArtifactDigest, standardCommit };

test('exact verified production evidence satisfies only the operations gate', async () => {
  const acceptor = new OperationsEvidenceAcceptor(binding, verifier);
  const records = [];
  for (const kind of ['retention-policy', 'deletion-drill', 'restore-drill', 'independent-security-review'] as const) records.push(await acceptor.accept(evidence(kind), now));
  const result = assessOperationsAssurance(records, assessmentBinding, now);
  assert.equal(result.operationsReady, true); assert.deepEqual(result.missing, []); assert.deepEqual(result.failed, []);
  assert.equal(result.fieldValidated, false); assert.equal(result.released, false);
});

test('missing, staging and latest failed evidence remain explicit release blockers', async () => {
  const acceptor = new OperationsEvidenceAcceptor(binding, verifier);
  const retained = await acceptor.accept(evidence('retention-policy'), now);
  const stagingDeletion = await acceptor.accept(evidence('deletion-drill', { environment: 'staging' }), now);
  const failedRestore = await acceptor.accept(evidence('restore-drill', { result: 'failed' }), now);
  const result = assessOperationsAssurance([retained, stagingDeletion, failedRestore], assessmentBinding, now);
  assert.equal(result.operationsReady, false);
  assert.deepEqual(result.satisfied, ['retention-policy']);
  assert.deepEqual(result.missing, ['deletion-drill', 'independent-security-review']);
  assert.deepEqual(result.failed, ['restore-drill']);
});

test('unknown, future, stale and cross-binding records reject before use', async () => {
  const cases: [Partial<OperationsEvidenceRecord>, RegExp][] = [
    [{ scope: { ...scope, tenantId: 'other' } }, /OPERATIONS_SCOPE_MISMATCH/],
    [{ subjectArtifactDigest: 'sha256:' + 'c'.repeat(64) }, /OPERATIONS_ARTIFACT_MISMATCH/],
    [{ standardCommit: 'c'.repeat(40) }, /OPERATIONS_STANDARD_MISMATCH/],
    [{ observedAtMs: now + 1, expiresAtMs: now + 100 }, /FUTURE_OPERATIONS_EVIDENCE/],
    [{ observedAtMs: 500, expiresAtMs: now + 100 }, /STALE_OPERATIONS_EVIDENCE/],
    [{ expiresAtMs: now }, /STALE_OPERATIONS_EVIDENCE/],
  ];
  for (const [changes, error] of cases) {
    const acceptor = new OperationsEvidenceAcceptor(binding, verifier);
    await assert.rejects(acceptor.accept(evidence('retention-policy', changes), now), error);
  }
  const acceptor = new OperationsEvidenceAcceptor(binding, verifier);
  await assert.rejects(acceptor.accept({ ...evidence('retention-policy'), secret: 'plaintext' } as OperationsEvidenceRecord, now), /INVALID_OPERATIONS_EVIDENCE_FIELDS/);
});

test('forgery, replayed IDs or reports, and self-review fail closed', async () => {
  const acceptor = new OperationsEvidenceAcceptor(binding, verifier);
  const forged = evidence('retention-policy', { evidenceDigest: 'sha256:' + 'f'.repeat(64) }); verified.delete(forged.evidenceDigest);
  await assert.rejects(acceptor.accept(forged, now), /UNVERIFIED_OPERATIONS_EVIDENCE/);
  const first = await acceptor.accept(evidence('retention-policy'), now);
  await assert.rejects(acceptor.accept(evidence('deletion-drill', { evidenceId: first.evidenceId }), now), /DUPLICATE_OPERATIONS_EVIDENCE_ID/);
  await assert.rejects(acceptor.accept(evidence('deletion-drill', { evidenceDigest: first.evidenceDigest }), now), /DUPLICATE_OPERATIONS_EVIDENCE_DIGEST/);
  await assert.rejects(acceptor.accept(evidence('independent-security-review', { subjectId: 'same', verifierId: 'same' }), now), /SELF_REVIEW_IS_NOT_INDEPENDENT/);
});

test('copied or expired accepted records cannot become release evidence', async () => {
  const acceptor = new OperationsEvidenceAcceptor(binding, verifier);
  const record = await acceptor.accept(evidence('retention-policy'), now);
  assert.throws(() => assessOperationsAssurance([{ ...record }], assessmentBinding, now), /UNAUTHENTICATED_OPERATIONS_EVIDENCE/);
  const later = assessOperationsAssurance([record], assessmentBinding, record.expiresAtMs);
  assert.deepEqual(later.satisfied, []); assert.ok(later.missing.includes('retention-policy'));
});
