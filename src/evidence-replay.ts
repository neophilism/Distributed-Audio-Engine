import type { QualifyingInterval } from './evidence.js';
import { contributionCoverage } from './evidence.js';
import { canonicalJson, integer, invariant } from './validation.js';

/** Production adapters must persist a unique key with an atomic insert-if-absent. */
export interface AtomicEvidenceClaimStore {
  claimOnce(key: string, expiresAtMs: number): Promise<boolean>;
}

/** Replay guard for already-authenticated, already-qualified evidence decisions. */
export class SignedEvidenceReplayGate {
  constructor(private readonly store: AtomicEvidenceClaimStore, private readonly nowMs: () => number) {
    invariant(store && typeof store.claimOnce === 'function' && typeof nowMs === 'function',
      'EVIDENCE_REPLAY_ADAPTER_REQUIRED');
  }
  async consume(decision: QualifyingInterval, expiresAtMs: number): Promise<boolean> {
    invariant(decision && typeof decision === 'object', 'INVALID_EVIDENCE_DECISION');
    if (!decision.qualified) return false;
    // The core evaluator brands genuine decisions; copied/forged values fail.
    contributionCoverage([decision]);
    const now = this.nowMs(); integer(now, 0);
    integer(expiresAtMs, now + 1, now + 86400000);
    const key = canonicalJson({
      scope: decision.scope, evidenceId: decision.evidenceId, policyVersion: decision.policyVersion
    });
    const result = await this.store.claimOnce(key, expiresAtMs);
    invariant(typeof result === 'boolean', 'INVALID_EVIDENCE_STORE_RESULT');
    return result;
  }
}
