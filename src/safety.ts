import { finite, integer, invariant } from './validation.js';
import { ControlVerifier } from './controls.js';
import type { ControlBody,SignedControl } from './controls.js';
export interface LeasePolicy {expiresAtMs:number;stopAtMs:number;fadeMs:number;maxLinearGain:number}
export type ControlPayloadDecoder=(authenticatedBody:ControlBody)=>Promise<unknown>;
/** An endpoint renders only within both user consent and current signed authority. */
export class PlaybackAuthority {
  private lease:LeasePolicy|undefined;
  private muted=false;
  private userGain:number;
  private lastTimeMs=0;
  private operationGeneration=0;
  constructor(private readonly controls:ControlVerifier,private readonly decode:ControlPayloadDecoder,private readonly consentedGainCeiling:number){finite(consentedGainCeiling,0,1);this.userGain=consentedGainCeiling;}
  private observeTime(nowMs:number):void{integer(nowMs);invariant(nowMs>=this.lastTimeMs,'AUTHORITY_TIME_ROLLBACK');this.lastTimeMs=nowMs;}
  async renew(control:SignedControl,nowMs:number):Promise<void>{
    this.observeTime(nowMs);
    invariant(control.body.action==='lease','WRONG_CONTROL_ACTION');
    const body=await this.controls.accept(control,nowMs);const generation=++this.operationGeneration;const payload=await this.decode(body);
    invariant(payload&&typeof payload==='object'&&Object.keys(payload).sort().join(',')==='expiresAtMs,fadeMs,maxLinearGain,stopAtMs','INVALID_LEASE_PAYLOAD');
    const policy=structuredClone(payload) as LeasePolicy;
    integer(policy.expiresAtMs,nowMs+1,body.expiresAtMs);integer(policy.stopAtMs,nowMs+1);integer(policy.fadeMs,1,30000);finite(policy.maxLinearGain,0,this.consentedGainCeiling);
    invariant(policy.fadeMs<=Math.min(policy.expiresAtMs,policy.stopAtMs)-nowMs,'LEASE_TOO_SHORT_FOR_FADE');
    invariant(nowMs>=this.lastTimeMs,'AUTHORITY_CONCURRENT_TIME_ADVANCE');
    invariant(generation===this.operationGeneration,'AUTHORITY_CONTROL_SUPERSEDED');
    this.lease=policy;
  }
  async emergencyStop(control:SignedControl,nowMs:number):Promise<void>{
    this.observeTime(nowMs);invariant(control.body.action==='emergency-stop','WRONG_CONTROL_ACTION');
    await this.controls.accept(control,nowMs);this.operationGeneration++;this.lease=undefined;
  }
  setUserGain(gain:number):void{finite(gain,0,this.consentedGainCeiling);this.userGain=gain;}
  mute(muted=true):void{this.muted=muted;}
  leave():void{this.operationGeneration++;this.lease=undefined;this.muted=true;}
  gainAt(nowMs:number):number{
    this.observeTime(nowMs);if(!this.lease||this.muted)return 0;
    const deadline=Math.min(this.lease.expiresAtMs,this.lease.stopAtMs);
    if(nowMs>=deadline){this.lease=undefined;return 0;}
    const fade=Math.min(1,(deadline-nowMs)/this.lease.fadeMs);
    return Math.min(this.userGain,this.lease.maxLinearGain)*fade;
  }
}
