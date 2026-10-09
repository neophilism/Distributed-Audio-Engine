import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileProgram,ProgramTimeline,resolveFrame } from '../src/index.js';
const clips=[{id:'a',assetId:'asset-a',frames:8000,markerAfter:'boundary-a'},{id:'b',assetId:'asset-b',frames:4000,markerAfter:'boundary-b'}];
test('listeners joining a running timeline get identical current targets and loop positions',()=>{
  const p=compileProgram('p',8000,clips);const a=new ProgramTimeline(1000,p);const b=new ProgramTimeline(1000,p);
  assert.deepEqual(a.targetAt(2375),b.targetAt(2375));assert.equal(a.targetAt(2375).clipId,'b');assert.equal(a.targetAt(2375).offsetFrames,3000);
  assert.equal(a.targetAt(2500).clipId,'a');assert.equal(a.targetAt(2500).loopIndex,1n);
});
test('future revisions switch exactly at a common loop boundary and close old markers',()=>{
  const t=new ProgramTimeline(1000,compileProgram('one',8000,clips));const next=compileProgram('two',8000,[{id:'new',assetId:'new-asset',frames:8000,markerAfter:'next'}]);
  t.publish(next,12000n,2000);assert.equal(t.targetAt(2499).programId,'one');assert.equal(t.targetAt(2500).programId,'two');
  const markers=t.markersBetween(7999n,12000n);assert.deepEqual(markers.map(m=>m.id),['boundary-a','boundary-b']);
});
test('duration, duplicate IDs, retroactive revisions and invalid boundaries reject',()=>{
  assert.throws(()=>compileProgram('p',8000,[clips[0]!,clips[0]!]));
  const t=new ProgramTimeline(1000,compileProgram('one',8000,clips));
  assert.throws(()=>t.publish(compileProgram('two',8000,clips),12001n,1500));
  assert.throws(()=>t.publish(compileProgram('two',8000,clips),12000n,2500));assert.throws(()=>t.targetAt(999));
});
test('large loop counts retain exact arithmetic and caller mutation cannot change published state',()=>{
  const p=compileProgram('one',8000,clips);const t=new ProgramTimeline(0,p);clips[0]!.assetId='mutated';
  assert.equal(t.targetAt(0).assetId,'asset-a');clips[0]!.assetId='asset-a';
  const result=resolveFrame(p,12000n*10n**30n+9000n);assert.equal(result.loopIndex,10n**30n);assert.equal(result.offsetFrames,1000);
  assert.throws(()=>t.markersBetween(0n,12000n*10000n));
});
