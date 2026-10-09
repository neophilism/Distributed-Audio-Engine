import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateLatency, summarizeTrials, percentile } from '../src/index.js';
test('short reference captures recover the actual inserted sample delay', () => {
  const ref=Float32Array.from({length:128},(_,i)=>Math.sin(i*0.17)*Math.cos(i*0.031)*0.8);
  const captured=new Float32Array(192); captured.set(ref,37);
  const result=estimateLatency(ref,captured,48000,64);
  assert.equal(result?.lagSamples,37); assert.ok(result!.correlation>0.99);
});
test('silence and unrelated audio remain inconclusive instead of calibrated', () => {
  assert.equal(estimateLatency(new Float32Array(32),new Float32Array(64),48000,32),null);
  const ref=Float32Array.from({length:32},(_,i)=>Math.sin(i));
  assert.equal(estimateLatency(ref,new Float32Array(64),48000,32),null);
  assert.throws(()=>estimateLatency(ref,new Float32Array(34),48000,32));
});
test('percentile preserves worst failures and rejects invalid numbers', () => {
  assert.equal(percentile([1,2,3,100],1),100);
  assert.throws(()=>percentile([1,NaN],0.95)); assert.throws(()=>percentile([],0.95));
});
test('simulated or incomplete trials can never authorize verified output', () => {
  const trials=[{origin:'simulated' as const,captureDigest:'a'.repeat(64),measurementMethod:'synthetic-impulse',routeChanged:false,absoluteSkewMs:1,dropout:false,calibratedLevel:true,sourceAttributed:true}];
  const p={maxP95SkewMs:10,maxWorstSkewMs:20,maxDropoutFraction:0.01,minTrials:1};
  const report=summarizeTrials(trials,p);
  assert.equal(report.candidateForReview,false); assert.equal(report.fieldValidated,false); assert.ok(report.problems.includes('SIMULATED_CAPTURE'));
  const candidate=summarizeTrials([{...trials[0]!,origin:'captured'}],p);
  assert.equal(candidate.candidateForReview,true); assert.equal(candidate.fieldValidated,false);
});
