import type { AcceptedAcousticEvidence, ContributionBand, QualifyingInterval } from './evidence.js';
import { evaluateContribution } from './evidence.js';
import { finite, identifier, integer, invariant } from './validation.js';

/** Immutable, neutral contribution rules. No output gain, rewards or radio semantics. */
export class PinnedContributionPolicy {
  private readonly policy: ContributionBand;
  constructor(input: ContributionBand) {
    invariant(input !== null && typeof input === 'object' &&
      Object.keys(input).sort().join(',') ===
      'allowedKinds,geometryId,maximumClockUncertaintyMs,maximumUncertaintyDb,measurementWindowMs,minimumDbA,safetyCeilingDbA,version',
      'INVALID_POLICY_FIELDS');
    identifier(input.version); identifier(input.geometryId);
    integer(input.measurementWindowMs, 1, 60000);
    finite(input.minimumDbA, 0, 160);
    finite(input.safetyCeilingDbA, input.minimumDbA, 160);
    finite(input.maximumUncertaintyDb, 0, 40);
    finite(input.maximumClockUncertaintyMs, 0, 5000);
    invariant(Array.isArray(input.allowedKinds) && input.allowedKinds.length > 0 &&
      input.allowedKinds.length <= 2 && new Set(input.allowedKinds).size === input.allowedKinds.length &&
      input.allowedKinds.every(kind => kind === 'bluetooth-speaker' || kind === 'wired-speaker'),
      'INVALID_CONTRIBUTION_ROUTES');
    this.policy = Object.freeze({ ...input, allowedKinds: Object.freeze([...input.allowedKinds]) });
  }
  snapshot(): ContributionBand { return structuredClone(this.policy); }
  evaluate(evidence: AcceptedAcousticEvidence, bounds: { fromMs: number; toMs: number }): QualifyingInterval {
    return evaluateContribution(evidence, this.policy, bounds);
  }
}
