import { finite, integer, invariant } from './validation.js';
export interface LatencyResult { lagSamples: number; latencyMs: number; correlation: number }
/** Short calibration captures only; no ambient recording retention/upload. */
export function estimateLatency(reference: Float32Array, observed: Float32Array, sampleRate: number, maxLagSamples: number): LatencyResult | null {
  integer(sampleRate, 8000, 192000); integer(maxLagSamples, 0, 8192);
  invariant(reference.length >= 16 && reference.length <= 8192 && observed.length >= reference.length + maxLagSamples && observed.length <= 16384, 'INVALID_CALIBRATION_CAPTURE');
  for (const sample of [...reference, ...observed]) finite(sample, -1, 1);
  const mean = reference.reduce((sum, sample) => sum + sample, 0) / reference.length;
  const centered = reference.map(sample => sample - mean);
  const refEnergy = centered.reduce((sum, sample) => sum + sample * sample, 0);
  if (refEnergy < 1e-12) return null;
  let bestCorrelation = -Infinity; let bestLag = 0;
  for (let lag = 0; lag <= maxLagSamples; lag++) {
    let obsMean = 0;
    for (let i = 0; i < centered.length; i++) obsMean += observed[i + lag]!;
    obsMean /= centered.length;
    let dot = 0; let obsEnergy = 0;
    for (let i = 0; i < centered.length; i++) {
      const sample = observed[i + lag]! - obsMean;
      dot += centered[i]! * sample; obsEnergy += sample * sample;
    }
    const correlation = obsEnergy < 1e-12 ? -Infinity : dot / Math.sqrt(refEnergy * obsEnergy);
    if (correlation > bestCorrelation) { bestCorrelation = correlation; bestLag = lag; }
  }
  if (bestCorrelation < 0.95) return null;
  return { lagSamples: bestLag, latencyMs: 1000 * bestLag / sampleRate, correlation: Math.min(1, bestCorrelation) };
}
export function percentile(values: readonly number[], quantile: number): number {
  invariant(values.length > 0, 'EMPTY_MEASUREMENTS'); finite(quantile, 0, 1);
  for (const value of values) finite(value, 0);
  const ordered = [...values].sort((a,b)=>a-b);
  return ordered[Math.max(0, Math.ceil(quantile * ordered.length) - 1)]!;
}
export interface FeasibilityTrial {
  origin: 'simulated' | 'captured';
  captureDigest: string;
  measurementMethod: string;
  routeChanged: boolean;
  absoluteSkewMs: number;
  dropout: boolean;
  calibratedLevel: boolean;
  sourceAttributed: boolean;
}
export interface FeasibilityPolicy { maxP95SkewMs: number; maxWorstSkewMs: number; maxDropoutFraction: number; minTrials: number }
export function summarizeTrials(trials: readonly FeasibilityTrial[], policy: FeasibilityPolicy) {
  integer(policy.minTrials, 1); finite(policy.maxP95SkewMs, 0); finite(policy.maxWorstSkewMs, policy.maxP95SkewMs); finite(policy.maxDropoutFraction, 0, 1);
  invariant(trials.length > 0, 'EMPTY_TRIALS');
  for (const trial of trials) {
    finite(trial.absoluteSkewMs, 0);
    invariant(trial.origin === 'simulated' || trial.origin === 'captured', 'INVALID_TRIAL_ORIGIN');
    invariant(/^[0-9a-f]{64}$/.test(trial.captureDigest) && trial.measurementMethod.length > 0, 'MISSING_TRIAL_PROVENANCE');
  }
  const p95SkewMs = percentile(trials.map(t=>t.absoluteSkewMs),0.95);
  const worstSkewMs = Math.max(...trials.map(t=>t.absoluteSkewMs));
  const dropoutFraction = trials.filter(t=>t.dropout).length / trials.length;
  const problems: string[] = [];
  if (trials.some(t=>t.origin === 'simulated')) problems.push('SIMULATED_CAPTURE');
  if (trials.length < policy.minTrials) problems.push('INSUFFICIENT_TRIALS');
  if (trials.some(t=>t.routeChanged)) problems.push('ROUTE_CHANGED');
  if (p95SkewMs > policy.maxP95SkewMs || worstSkewMs > policy.maxWorstSkewMs) problems.push('TIMING_TARGET_MISSED');
  if (dropoutFraction > policy.maxDropoutFraction) problems.push('DROPOUT_TARGET_MISSED');
  if (trials.some(t=>!t.calibratedLevel || !t.sourceAttributed)) problems.push('OUTPUT_EVIDENCE_INCOMPLETE');
  // Numerical success is only a candidate report, not authenticated field assurance.
  return {p95SkewMs,worstSkewMs,dropoutFraction,problems,candidateForReview:problems.length===0,fieldValidated:false as const};
}
