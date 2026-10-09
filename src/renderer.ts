import { finite, identifier, integer, invariant } from './validation.js';
import { validateScene,validateSpeakers } from './spatial.js';
import type { SpatialScene,SpatialSpeaker } from './spatial.js';
export interface MixPlan {sceneId:string;revision:number;sourceIds:string[];speakerIds:string[];gains:Record<string,Record<string,number>>;ceilings:Record<string,number>;missingSourceIds:string[]}
export interface PositionPolicy {nowMs:number;maxAgeMs:number;minConfidence:number}
export function createMixPlan(scene:SpatialScene,speakers:readonly SpatialSpeaker[],policy:PositionPolicy):MixPlan{
  validateScene(scene);validateSpeakers(speakers);integer(policy.nowMs);integer(policy.maxAgeMs,1);finite(policy.minConfidence,0,1);
  const active=speakers.filter(s=>s.maxLinearGain>0&&s.confidence>=policy.minConfidence&&(s.placement==='fixed'||(s.positionAtMs<=policy.nowMs&&policy.nowMs-s.positionAtMs<=policy.maxAgeMs)));
  const gains:MixPlan['gains']=Object.create(null) as MixPlan['gains'];const ceilings:MixPlan['ceilings']=Object.create(null) as MixPlan['ceilings'];const missingSourceIds:string[]=[];
  for(const s of active){gains[s.id]=Object.create(null) as Record<string,number>;ceilings[s.id]=s.maxLinearGain;}
  for(const source of scene.sources){
    const weights=active.map(s=>{
      const distance=Math.hypot(source.position.x-s.position.x,source.position.y-s.position.y,source.position.z-s.position.z);
      const capability=Object.hasOwn(s.roleWeights,source.role)?s.roleWeights[source.role]!:0;
      return capability*s.maxLinearGain/(1+(distance/source.spreadMeters)**2);
    });
    const energy=weights.reduce((sum,w)=>sum+w*w,0);
    if(energy===0&&source.gain>0)missingSourceIds.push(source.id);
    for(let i=0;i<active.length;i++)gains[active[i]!.id]![source.id]=energy===0?0:source.gain*weights[i]!/Math.sqrt(energy);
  }
  // Preserve source balance using one common attenuation factor, and bound every
  // speaker's worst-case sum so multiple full-scale stems cannot clip the mix.
  let scale=1;
  for(const s of active){const peak=Object.values(gains[s.id]!).reduce((sum,x)=>sum+x,0);if(peak>0)scale=Math.min(scale,s.maxLinearGain/peak);}
  for(const row of Object.values(gains))for(const id of Object.keys(row))row[id]=row[id]!*scale;
  return{sceneId:scene.id,revision:scene.revision,sourceIds:scene.sources.map(s=>s.id),speakerIds:active.map(s=>s.id),gains,ceilings,missingSourceIds};
}
function validatePlan(plan:MixPlan):void{
  invariant(plan.sourceIds.length>0&&plan.sourceIds.length<=256&&plan.speakerIds.length<=4096,'INVALID_MIX_SHAPE');
  invariant(new Set(plan.sourceIds).size===plan.sourceIds.length&&new Set(plan.speakerIds).size===plan.speakerIds.length,'DUPLICATE_MIX_ID');
  for(const id of [...plan.sourceIds,...plan.speakerIds])identifier(id);
  for(const speaker of plan.speakerIds){
    const row=plan.gains[speaker];invariant(row&&Object.keys(row).length===plan.sourceIds.length,'INVALID_MIX_ROW');finite(plan.ceilings[speaker]!,0,1);
    for(const source of plan.sourceIds){invariant(Object.hasOwn(row,source),'MISSING_SOURCE_GAIN');finite(row[source]!,0,1);}
    invariant(Object.values(row).reduce((sum,x)=>sum+x,0)<=plan.ceilings[speaker]!+1e-12,'MIX_EXCEEDS_CEILING');
  }
}
/** Aligned mono PCM chunks; decoding/decryption happen at authorized endpoints. */
export function renderSpatialChunk(plan:MixPlan,stems:Readonly<Record<string,Float32Array>>):Record<string,Float32Array>{
  validatePlan(plan);const first=stems[plan.sourceIds[0]!];invariant(first&&Object.hasOwn(stems,plan.sourceIds[0]!),'MISSING_STEM');
  integer(first.length,1,65536);invariant(first.length*plan.speakerIds.length<=32*1024*1024,'RENDER_MEMORY_LIMIT');
  for(const source of plan.sourceIds){const input=stems[source];invariant(input&&Object.hasOwn(stems,source)&&input.length===first.length,'STEM_CHUNK_ALIGNMENT');for(const sample of input)finite(sample,-1,1);}
  const result:Record<string,Float32Array>=Object.create(null) as Record<string,Float32Array>;
  for(const speaker of plan.speakerIds){
    const output=new Float32Array(first.length);
    for(let frame=0;frame<output.length;frame++){
      let mixed=0;for(const source of plan.sourceIds)mixed+=stems[source]![frame]!*plan.gains[speaker]![source]!;
      output[frame]=mixed;
    }
    result[speaker]=output;
  }
  return result;
}
/** Convex interpolation on a stable speaker/source set keeps gains bounded. */
export function interpolateMixPlans(previous:MixPlan,next:MixPlan,progress:number):MixPlan{
  validatePlan(previous);validatePlan(next);finite(progress,0,1);
  invariant(JSON.stringify(previous.sourceIds)===JSON.stringify(next.sourceIds)&&JSON.stringify(previous.speakerIds)===JSON.stringify(next.speakerIds),'MIX_TOPOLOGY_CHANGE');
  const result=structuredClone(next);
  for(const speaker of result.speakerIds){
    result.ceilings[speaker]=Math.min(previous.ceilings[speaker]!,next.ceilings[speaker]!);
    for(const source of result.sourceIds)result.gains[speaker]![source]=previous.gains[speaker]![source]!*(1-progress)+next.gains[speaker]![source]!*progress;
    const peak=Object.values(result.gains[speaker]!).reduce((sum,x)=>sum+x,0);const ceiling=result.ceilings[speaker]!;
    if(peak>ceiling)for(const source of result.sourceIds)result.gains[speaker]![source]=result.gains[speaker]![source]!*ceiling/peak;
  }
  return result;
}
