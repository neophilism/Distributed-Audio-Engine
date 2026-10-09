import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlacementRegistry } from '../src/index.js';
import type { PositionObservation } from '../src/index.js';
const policy={maxAgeMs:1000,maxUncertaintyMeters:1,minConfidence:0.9};
function observation(overrides:Partial<PositionObservation>={}):PositionObservation{return{objectId:'object',trackerId:'tracker',sequence:1,position:{x:10,y:0,z:0},atMs:1000,uncertaintyMeters:0.5,confidence:0.95,method:'validated-coordinate',...overrides};}
test('fixed placement survives owner movement and cannot be updated by tracker observations',()=>{
  const r=new PlacementRegistry(policy);r.setFixed('object',{x:1,y:2,z:0},1000);assert.deepEqual(r.positionAt('object',100000)?.position,{x:1,y:2,z:0});
  assert.throws(()=>r.observe(observation(),1200));
});
test('tracking is tied to the physical object and bound tracker with conservative validity',()=>{
  const r=new PlacementRegistry(policy);r.bindTracked('object','tracker');assert.equal(r.positionAt('object',1000),null);r.observe(observation(),1200);
  assert.equal(r.positionAt('object',1500)?.position.x,10);assert.equal(r.positionAt('object',2001),null);
  assert.throws(()=>r.observe(observation({sequence:2,trackerId:'owner-phone'}),1500));
});
test('presence-only, stale, low-confidence and replayed coordinates remain ineligible',()=>{
  const r=new PlacementRegistry(policy);r.bindTracked('object','tracker');
  for(const o of [observation({method:'presence-only'}),observation({atMs:1}),observation({confidence:0.8}),observation({uncertaintyMeters:2}),observation({atMs:2000})])assert.throws(()=>r.observe(o,1200));
  r.observe(observation(),1200);assert.throws(()=>r.observe(observation(),1200));
});
test('position outputs and policy snapshots cannot mutate registered placement',()=>{
  const mutable={...policy};const r=new PlacementRegistry(mutable);r.bindTracked('object','tracker');mutable.minConfidence=0;
  assert.throws(()=>r.observe(observation({confidence:0.5}),1200));r.observe(observation(),1200);
  r.positionAt('object',1500)!.position.x=999;assert.equal(r.positionAt('object',1501)?.position.x,10);r.unbind('object');assert.equal(r.positionAt('object',1502),null);
});
