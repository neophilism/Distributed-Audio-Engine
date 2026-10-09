import { finite, identifier, integer, invariant } from './validation.js';
import type { Position } from './contracts.js';
export interface SpatialSource {id:string;assetId:string;position:Position;spreadMeters:number;gain:number;role:string}
export interface SpatialSpeaker {id:string;position:Position;roleWeights:Record<string,number>;maxLinearGain:number;placement:'fixed'|'tracked';positionAtMs:number;confidence:number}
export interface SpatialScene {id:string;revision:number;sampleRate:number;frames:number;sources:SpatialSource[]}
/** Generic physical anchors; product-specific naming and permissions stay in consumers. */
export interface PhysicalAnchor {id:string;sourceId:string;position:Position;positionAtMs:number;confidence:number;method:'manual'|'validated-position'|'presence-only'}
export function validatePosition(position:Position):void{
  invariant(position&&Object.keys(position).sort().join(',')==='x,y,z','INVALID_POSITION');
  finite(position.x,-100000,100000);finite(position.y,-100000,100000);finite(position.z,-100000,100000);
}
export function validateScene(scene:SpatialScene):void{
  identifier(scene.id);integer(scene.revision,1);integer(scene.sampleRate,8000,192000);integer(scene.frames,1);
  invariant(scene.sources.length>0&&scene.sources.length<=256,'INVALID_SOURCE_COUNT');const ids=new Set<string>();
  for(const source of scene.sources){
    invariant(Object.keys(source).sort().join(',')==='assetId,gain,id,position,role,spreadMeters','UNKNOWN_SOURCE_FIELDS');
    identifier(source.id);identifier(source.assetId);identifier(source.role);validatePosition(source.position);
    finite(source.spreadMeters,0.1,10000);finite(source.gain,0,1);invariant(!ids.has(source.id),'DUPLICATE_SOURCE');ids.add(source.id);
  }
}
export function validateSpeakers(speakers:readonly SpatialSpeaker[]):void{
  invariant(speakers.length<=4096,'TOO_MANY_SPEAKERS');const ids=new Set<string>();
  for(const speaker of speakers){
    identifier(speaker.id);invariant(!ids.has(speaker.id),'DUPLICATE_SPEAKER');ids.add(speaker.id);validatePosition(speaker.position);
    integer(speaker.positionAtMs);finite(speaker.confidence,0,1);finite(speaker.maxLinearGain,0,1);
    invariant(speaker.placement==='fixed'||speaker.placement==='tracked','INVALID_PLACEMENT');
    invariant(Object.keys(speaker.roleWeights).length<=256,'TOO_MANY_ROLES');
    for(const[role,weight]of Object.entries(speaker.roleWeights)){identifier(role);finite(weight,0,1);}
  }
}
export function applyAnchor(scene:SpatialScene,anchor:PhysicalAnchor,nowMs:number,maxAgeMs:number,minConfidence:number):SpatialScene{
  validateScene(scene);identifier(anchor.id);identifier(anchor.sourceId);validatePosition(anchor.position);
  integer(nowMs);integer(maxAgeMs,1);integer(anchor.positionAtMs);finite(minConfidence,0,1);finite(anchor.confidence,0,1);
  invariant(anchor.method==='manual'||anchor.method==='validated-position','ANCHOR_HAS_NO_POSITION');
  invariant(anchor.positionAtMs<=nowMs&&nowMs-anchor.positionAtMs<=maxAgeMs&&anchor.confidence>=minConfidence,'ANCHOR_POSITION_UNCERTAIN');
  invariant(scene.sources.some(s=>s.id===anchor.sourceId),'ANCHOR_SOURCE_MISSING');
  const next=structuredClone(scene);next.revision++;integer(next.revision,1);
  next.sources.find(s=>s.id===anchor.sourceId)!.position={...anchor.position};return next;
}
