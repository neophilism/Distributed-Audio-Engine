import { canonicalJson, identifier, integer, invariant } from './validation.js';
import type { IdentityScope, AuthenticatedActor } from './identity.js';
import { requireAccess } from './identity.js';
export type PermittedUse='stream'|'public-playback'|'cache'|'download'|'sale'|'derive-spatial';
export type RightsLayer='recording'|'composition'|'spoken-work'|'artwork';
export interface RightsGrant {
  id:string;assetId:string;layer:RightsLayer;uses:PermittedUse[];territories:string[];
  validFromMs:number;validUntilMs:number;authorizationEvidenceRef:string;revoked:boolean;
}
export interface RightsRequest {assetId:string;layers:RightsLayer[];uses:PermittedUse[];territory:string;atMs:number}
export type RightsDecision={allowed:true;grantIds:string[]}|{allowed:false;reason:'MISSING_PERMISSION';missing:string[]};
const uses=new Set<PermittedUse>(['stream','public-playback','cache','download','sale','derive-spatial']);
const layers=new Set<RightsLayer>(['recording','composition','spoken-work','artwork']);
/** Endpoint policy records; an evidence reference is not a legal ownership finding. */
export class RightsCatalog {
  private readonly grants=new Map<string,RightsGrant>();
  private readonly scope:IdentityScope;
  constructor(scope:IdentityScope){
    identifier(scope.tenantId); identifier(scope.identityId);
    invariant(scope.application==='scenesignal'||scope.application==='distributed-radio','INVALID_APPLICATION');
    this.scope=structuredClone(scope);
  }
  matchesScope(scope:IdentityScope):boolean{return canonicalJson(scope)===canonicalJson(this.scope);}
  add(actor:AuthenticatedActor,grant:RightsGrant,nowMs:number):void{
    requireAccess(actor,this.scope,'rights:write',nowMs);const g=structuredClone(grant);
    invariant(Object.keys(g).sort().join(',')==='assetId,authorizationEvidenceRef,id,layer,revoked,territories,uses,validFromMs,validUntilMs','UNKNOWN_RIGHTS_FIELDS');
    identifier(g.id);identifier(g.assetId);invariant(layers.has(g.layer),'INVALID_RIGHTS_LAYER');
    invariant(g.uses.length>0&&new Set(g.uses).size===g.uses.length&&g.uses.every(u=>uses.has(u)),'INVALID_RIGHTS_USES');
    invariant(g.territories.length>0&&new Set(g.territories).size===g.territories.length&&g.territories.every(t=>t==='*'||/^[A-Z]{2}$/.test(t)),'INVALID_RIGHTS_TERRITORY');
    integer(g.validFromMs);integer(g.validUntilMs,g.validFromMs+1);invariant(typeof g.revoked==='boolean','INVALID_REVOCATION_FLAG');
    invariant(/^sha256:[0-9a-f]{64}$/.test(g.authorizationEvidenceRef),'MISSING_AUTHORIZATION_EVIDENCE');
    invariant(!this.grants.has(g.id),'RIGHTS_GRANT_ID_REUSE');this.grants.set(g.id,g);
  }
  revoke(actor:AuthenticatedActor,id:string,nowMs:number):void{
    requireAccess(actor,this.scope,'rights:write',nowMs);const g=this.grants.get(id);invariant(g,'UNKNOWN_RIGHTS_GRANT');g.revoked=true;
  }
  evaluate(request:RightsRequest):RightsDecision{
    identifier(request.assetId);integer(request.atMs);
    invariant(/^[A-Z]{2}$/.test(request.territory),'INVALID_RIGHTS_TERRITORY');
    invariant(request.layers.length>0&&new Set(request.layers).size===request.layers.length&&request.layers.every(l=>layers.has(l)),'INVALID_RIGHTS_LAYER');
    invariant(request.uses.length>0&&new Set(request.uses).size===request.uses.length&&request.uses.every(u=>uses.has(u)),'INVALID_RIGHTS_USES');
    const missing:string[]=[];const matches=new Set<string>();
    for(const layer of request.layers)for(const use of request.uses){
      const grant=[...this.grants.values()].find(g=>g.assetId===request.assetId&&g.layer===layer&&!g.revoked&&g.validFromMs<=request.atMs&&g.validUntilMs>request.atMs&&g.uses.includes(use)&&(g.territories.includes('*')||g.territories.includes(request.territory)));
      if(grant)matches.add(grant.id);else missing.push(`${layer}:${use}`);
    }
    return missing.length?{allowed:false,reason:'MISSING_PERMISSION',missing}:{allowed:true,grantIds:[...matches].sort()};
  }
}
