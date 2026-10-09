import { finite,identifier,integer,invariant } from './validation.js';
import { validatePosition } from './spatial.js';
import type { Position } from './contracts.js';
export interface PositionObservation {objectId:string;trackerId:string;sequence:number;position:Position;atMs:number;uncertaintyMeters:number;confidence:number;method:'validated-coordinate'|'presence-only'}
export interface TrackingPolicy {maxAgeMs:number;maxUncertaintyMeters:number;minConfidence:number}
interface Placement {kind:'fixed'|'tracked';position:Position;atMs:number;trackerId:string|null;sequence:number;uncertaintyMeters:number;confidence:number}
/** Coordinates are object-specific; a phone's position is never an implicit input. */
export class PlacementRegistry {
  private readonly placements=new Map<string,Placement>();
  private readonly policy:TrackingPolicy;
  constructor(policy:TrackingPolicy){integer(policy.maxAgeMs,1);finite(policy.maxUncertaintyMeters,0);finite(policy.minConfidence,0,1);this.policy={...policy};}
  setFixed(objectId:string,position:Position,nowMs:number):void{
    identifier(objectId);validatePosition(position);integer(nowMs);
    this.placements.set(objectId,{kind:'fixed',position:{...position},atMs:nowMs,trackerId:null,sequence:0,uncertaintyMeters:0,confidence:1});
  }
  bindTracked(objectId:string,trackerId:string):void{
    identifier(objectId);identifier(trackerId);
    this.placements.set(objectId,{kind:'tracked',position:{x:0,y:0,z:0},atMs:0,trackerId,sequence:0,uncertaintyMeters:0,confidence:0});
  }
  observe(observation:PositionObservation,nowMs:number):void{
    const o=structuredClone(observation);identifier(o.objectId);identifier(o.trackerId);validatePosition(o.position);integer(o.sequence,1);integer(o.atMs);integer(nowMs);
    finite(o.uncertaintyMeters,0);finite(o.confidence,0,1);const current=this.placements.get(o.objectId);
    invariant(current?.kind==='tracked'&&current.trackerId===o.trackerId,'TRACKER_NOT_BOUND');
    invariant(o.method==='validated-coordinate','PRESENCE_IS_NOT_POSITION');
    invariant(o.sequence>current.sequence&&o.atMs>=current.atMs,'TRACKING_REPLAY_OR_ROLLBACK');
    invariant(o.atMs<=nowMs&&nowMs-o.atMs<=this.policy.maxAgeMs&&o.uncertaintyMeters<=this.policy.maxUncertaintyMeters&&o.confidence>=this.policy.minConfidence,'TRACKING_INCONCLUSIVE');
    this.placements.set(o.objectId,{...current,position:{...o.position},atMs:o.atMs,sequence:o.sequence,uncertaintyMeters:o.uncertaintyMeters,confidence:o.confidence});
  }
  positionAt(objectId:string,nowMs:number):{position:Position;state:'fixed'|'tracked'}|null{
    integer(nowMs);const current=this.placements.get(objectId);if(!current)return null;
    if(current.kind==='fixed')return{position:{...current.position},state:'fixed'};
    if(current.sequence===0||current.atMs>nowMs||nowMs-current.atMs>this.policy.maxAgeMs)return null;
    return{position:{...current.position},state:'tracked'};
  }
  unbind(objectId:string):void{this.placements.delete(objectId);}
}
