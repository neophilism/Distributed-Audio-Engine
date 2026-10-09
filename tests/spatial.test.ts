import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScene,validateSpeakers,applyAnchor } from '../src/index.js';
import type { SpatialScene,SpatialSpeaker,PhysicalAnchor } from '../src/index.js';
export const scene:SpatialScene={id:'scene',revision:1,sampleRate:48000,frames:100,sources:[{id:'strings',assetId:'asset',position:{x:0,y:0,z:0},spreadMeters:5,gain:1,role:'mid'}]};
export const speaker:SpatialSpeaker={id:'speaker',position:{x:0,y:0,z:0},roleWeights:{mid:1},maxLinearGain:1,placement:'fixed',positionAtMs:1000,confidence:1};
test('scene contracts reject duplicate sources, non-finite positions and invalid gains',()=>{
  validateScene(scene);validateSpeakers([speaker]);
  assert.throws(()=>validateScene({...scene,sources:[scene.sources[0]!,scene.sources[0]!]}));
  assert.throws(()=>validateScene({...scene,sources:[{...scene.sources[0]!,position:{x:NaN,y:0,z:0}}]}));
  assert.throws(()=>validateSpeakers([speaker,speaker]));
  assert.throws(()=>validateSpeakers([{...speaker,maxLinearGain:2}]));
});
test('validated physical anchor changes the virtual source without changing speaker or phone position',()=>{
  const anchor:PhysicalAnchor={id:'object',sourceId:'strings',position:{x:10,y:5,z:0},positionAtMs:1000,confidence:1,method:'validated-position'};
  const next=applyAnchor(scene,anchor,1200,1000,0.9);
  assert.deepEqual(next.sources[0]!.position,anchor.position);assert.equal(next.revision,2);assert.equal(scene.sources[0]!.position.x,0);assert.equal(speaker.position.x,0);
  for(const a of [{...anchor,method:'presence-only' as const},{...anchor,confidence:0.5},{...anchor,positionAtMs:1},{...anchor,positionAtMs:1300}])assert.throws(()=>applyAnchor(scene,a,1200,1000,0.9));
});
