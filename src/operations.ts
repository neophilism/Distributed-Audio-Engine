import { canonicalJson, identifier, integer, invariant } from './validation.js';

export type OperationsEvidenceKind = 'retention-policy' | 'deletion-drill' | 'restore-drill' | 'independent-security-review';
export type OperationsEnvironment = 'development' | 'staging' | 'production';
export interface OperationsScope { tenantId: string; application: 'distributed-audio-engine'; componentId: string }
export interface OperationsEvidenceRecord {
  version: '1.0.0'; evidenceId: string; kind: OperationsEvidenceKind; scope: OperationsScope;
  subjectArtifactDigest: string; evidenceDigest: string; standardCommit: string;
  environment: OperationsEnvironment; observedAtMs: number; expiresAtMs: number;
  subjectId: string; verifierId: string; result: 'passed' | 'failed';
}
export interface OperationsEvidenceBinding {
  scope: OperationsScope; subjectArtifactDigest: string; standardCommit: string; maximumAgeMs: number;
}
export interface OperationsEvidenceVerifier {
  verify(record: Readonly<OperationsEvidenceRecord>): Promise<boolean>;
}

declare const acceptedOperationsEvidence: unique symbol;
export type AcceptedOperationsEvidence = Readonly<OperationsEvidenceRecord> & { readonly [acceptedOperationsEvidence]: true };
const accepted = new WeakSet<object>();
const requiredKinds: readonly OperationsEvidenceKind[] = ['retention-policy', 'deletion-drill', 'restore-drill', 'independent-security-review'];
const environments = new Set<OperationsEnvironment>(['development', 'staging', 'production']);
const results = new Set<OperationsEvidenceRecord['result']>(['passed', 'failed']);
const digest = /^sha256:[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40}$/;

function exact(value: object, keys: string, code: string): void {
  invariant(Object.keys(value).sort().join(',') === keys.split(',').sort().join(','), code);
}
function validateScope(value: OperationsScope): void {
  exact(value, 'tenantId,application,componentId', 'INVALID_OPERATIONS_SCOPE_FIELDS');
  identifier(value.tenantId); identifier(value.componentId);
  invariant(value.application === 'distributed-audio-engine', 'INVALID_OPERATIONS_APPLICATION');
}
function validateBinding(value: OperationsEvidenceBinding): void {
  exact(value, 'scope,subjectArtifactDigest,standardCommit,maximumAgeMs', 'INVALID_OPERATIONS_BINDING_FIELDS');
  validateScope(value.scope); invariant(digest.test(value.subjectArtifactDigest), 'INVALID_OPERATIONS_ARTIFACT_DIGEST');
  invariant(commit.test(value.standardCommit), 'INVALID_OPERATIONS_STANDARD_COMMIT');
  integer(value.maximumAgeMs, 1, 366 * 24 * 60 * 60 * 1000);
}
function validateRecord(value: OperationsEvidenceRecord): void {
  exact(value, 'version,evidenceId,kind,scope,subjectArtifactDigest,evidenceDigest,standardCommit,environment,observedAtMs,expiresAtMs,subjectId,verifierId,result', 'INVALID_OPERATIONS_EVIDENCE_FIELDS');
  invariant(value.version === '1.0.0', 'INVALID_OPERATIONS_EVIDENCE_VERSION');
  identifier(value.evidenceId); identifier(value.subjectId); identifier(value.verifierId); validateScope(value.scope);
  invariant(requiredKinds.includes(value.kind), 'INVALID_OPERATIONS_EVIDENCE_KIND');
  invariant(environments.has(value.environment), 'INVALID_OPERATIONS_ENVIRONMENT');
  invariant(results.has(value.result), 'INVALID_OPERATIONS_RESULT');
  invariant(digest.test(value.subjectArtifactDigest) && digest.test(value.evidenceDigest), 'INVALID_OPERATIONS_EVIDENCE_DIGEST');
  invariant(commit.test(value.standardCommit), 'INVALID_OPERATIONS_STANDARD_COMMIT');
  integer(value.observedAtMs); integer(value.expiresAtMs, value.observedAtMs + 1);
  if (value.kind === 'independent-security-review') invariant(value.verifierId !== value.subjectId, 'SELF_REVIEW_IS_NOT_INDEPENDENT');
}

/** Accepts only externally verified, exact-scope evidence; this class does not manufacture deployment evidence. */
export class OperationsEvidenceAcceptor {
  private readonly binding: OperationsEvidenceBinding;
  private readonly evidenceIds = new Set<string>();
  private readonly evidenceDigests = new Set<string>();
  constructor(binding: OperationsEvidenceBinding, private readonly verifier: OperationsEvidenceVerifier) {
    validateBinding(binding); this.binding = structuredClone(binding);
  }
  async accept(source: OperationsEvidenceRecord, nowMs: number): Promise<AcceptedOperationsEvidence> {
    integer(nowMs); invariant(source && typeof source === 'object', 'INVALID_OPERATIONS_EVIDENCE');
    const value = structuredClone(source); validateRecord(value);
    invariant(canonicalJson(value.scope) === canonicalJson(this.binding.scope), 'OPERATIONS_SCOPE_MISMATCH');
    invariant(value.subjectArtifactDigest === this.binding.subjectArtifactDigest, 'OPERATIONS_ARTIFACT_MISMATCH');
    invariant(value.standardCommit === this.binding.standardCommit, 'OPERATIONS_STANDARD_MISMATCH');
    invariant(value.observedAtMs <= nowMs, 'FUTURE_OPERATIONS_EVIDENCE');
    invariant(value.expiresAtMs > nowMs && nowMs - value.observedAtMs <= this.binding.maximumAgeMs, 'STALE_OPERATIONS_EVIDENCE');
    invariant(!this.evidenceIds.has(value.evidenceId), 'DUPLICATE_OPERATIONS_EVIDENCE_ID');
    invariant(!this.evidenceDigests.has(value.evidenceDigest), 'DUPLICATE_OPERATIONS_EVIDENCE_DIGEST');
    invariant(await this.verifier.verify(value), 'UNVERIFIED_OPERATIONS_EVIDENCE');
    this.evidenceIds.add(value.evidenceId); this.evidenceDigests.add(value.evidenceDigest);
    Object.freeze(value.scope); Object.freeze(value); accepted.add(value); return value as AcceptedOperationsEvidence;
  }
}

export interface OperationsAssurance {
  operationsReady: boolean;
  satisfied: OperationsEvidenceKind[];
  missing: OperationsEvidenceKind[];
  failed: OperationsEvidenceKind[];
  subjectArtifactDigest: string;
  standardCommit: string;
  fieldValidated: false;
  released: false;
}

/** Production evidence must satisfy every gate. This result is not full-product release or field evidence. */
export function assessOperationsAssurance(records: readonly AcceptedOperationsEvidence[], binding: Omit<OperationsEvidenceBinding, 'maximumAgeMs'>, nowMs: number): OperationsAssurance {
  integer(nowMs); validateScope(binding.scope);
  invariant(digest.test(binding.subjectArtifactDigest), 'INVALID_OPERATIONS_ARTIFACT_DIGEST');
  invariant(commit.test(binding.standardCommit), 'INVALID_OPERATIONS_STANDARD_COMMIT');
  invariant(records.length <= 128, 'OPERATIONS_EVIDENCE_LIMIT');
  const current = new Map<OperationsEvidenceKind, AcceptedOperationsEvidence[]>();
  for (const record of records) {
    invariant(accepted.has(record), 'UNAUTHENTICATED_OPERATIONS_EVIDENCE');
    invariant(canonicalJson(record.scope) === canonicalJson(binding.scope), 'OPERATIONS_SCOPE_MISMATCH');
    invariant(record.subjectArtifactDigest === binding.subjectArtifactDigest, 'OPERATIONS_ARTIFACT_MISMATCH');
    invariant(record.standardCommit === binding.standardCommit, 'OPERATIONS_STANDARD_MISMATCH');
    if (record.environment !== 'production' || record.expiresAtMs <= nowMs || record.observedAtMs > nowMs) continue;
    const rows = current.get(record.kind) ?? []; rows.push(record); current.set(record.kind, rows);
  }
  const satisfied: OperationsEvidenceKind[] = [], missing: OperationsEvidenceKind[] = [], failed: OperationsEvidenceKind[] = [];
  for (const kind of requiredKinds) {
    const rows = current.get(kind) ?? [];
    if (rows.length === 0) { missing.push(kind); continue; }
    const newest = Math.max(...rows.map(row => row.observedAtMs));
    if (rows.filter(row => row.observedAtMs === newest).every(row => row.result === 'passed')) satisfied.push(kind);
    else failed.push(kind);
  }
  return Object.freeze({
    operationsReady: satisfied.length === requiredKinds.length,
    satisfied, missing, failed,
    subjectArtifactDigest: binding.subjectArtifactDigest,
    standardCommit: binding.standardCommit,
    fieldValidated: false as const,
    released: false as const,
  });
}
