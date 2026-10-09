import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMixPlan,renderSpatialChunk,interpolateMixPlans } from '../src/index.js';
import type { SpatialScene,SpatialSpeaker } from '../src/index.js';
const scene:SpatialScene={id:'scene',revision:1,sampleRate:48000,frames:100,sources:[{id:'source',assetId:'asset',position:{x:0,y:0,z:0},spreadMeters:5,gain:1,role:'mid'}]};
function speaker(id:string,x=0):SpatialSpeaker{return{id,position:{x,y:0,z:0},roleWeights:{mid:1},maxLinearGain:1,placement:'fixed',positionAtMs:0,confidence:1};}
const policy={nowMs:1000,maxAgeMs:500,minConfidence:0.9};
test('position-dependent source gain favors nearby capable outputs',()=>{
  const p=createMixPlan(scene,[speaker('near'),speaker('far',20)],policy);assert.ok(p.gains['near']!['source']!>p.gains['far']!['source']!);
  const out=renderSpatialChunk(p,{source:Float32Array.from([1,-1,0])});assert.ok(out['near']![0]!>out['far']![0]!);
});
test('adding output density does not multiply normalized source energy',()=>{
  const p=createMixPlan(scene,Array.from({length:100},(_,i)=>speaker('s'+i)),policy);
  const energy=p.speakerIds.reduce((sum,id)=>sum+p.gains[id]!['source']!**2,0);assert.ok(Math.abs(energy-1)<1e-10);
});
test('multi-source rendering remains bounded and reports missing capability',()=>{
  const s={...scene,sources:[scene.sources[0]!,{...scene.sources[0]!,id:'other'}]};const p=createMixPlan(s,[speaker('one')],policy);
  const out=renderSpatialChunk(p,{source:Float32Array.from([1,-1]),other:Float32Array.from([1,-1])});assert.deepEqual([...out['one']!],[1,-1]);
  const unsupported=createMixPlan({...scene,sources:[{...scene.sources[0]!,role:'bass'}]},[speaker('one')],policy);assert.deepEqual(unsupported.missingSourceIds,['source']);
});
test('fixed placements remain fixed; stale tracked locations exclude and transitions stay bounded',()=>{
  const a=createMixPlan(scene,[speaker('one')],policy);const b=createMixPlan({...scene,revision:2,sources:[{...scene.sources[0]!,gain:0.5}]},[speaker('one')],policy);
  assert.equal(interpolateMixPlans(a,b,0.5).gains['one']!['source'],0.75);
  assert.equal(createMixPlan(scene,[{...speaker('tracked'),placement:'tracked'}],policy).speakerIds.length,0);
  assert.throws(()=>renderSpatialChunk(a,{source:Float32Array.from([NaN])}));
});
