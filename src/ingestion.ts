import { canonicalJson, identifier, integer, invariant } from './validation.js';
import { requireAccess } from './identity.js';
import type { AuthenticatedActor, IdentityScope } from './identity.js';
export interface CiphertextStore {
  put(locator: string, ciphertext: Uint8Array): Promise<void>;
  get(locator: string): Promise<Uint8Array | undefined>;
  delete(locator: string): Promise<void>;
}
export class MemoryCiphertextStore implements CiphertextStore {
  private readonly objects=new Map<string,Uint8Array>();
  async put(key:string,bytes:Uint8Array){this.objects.set(key,Uint8Array.from(bytes));}
  async get(key:string){const value=this.objects.get(key);return value?Uint8Array.from(value):undefined;}
  async delete(key:string){this.objects.delete(key);}
}
export interface UploadRequest {
  scope: IdentityScope;
  uploadId: string;
  storageObjectId: string;
  ciphertextSizeBytes: number;
  chunkDigestsHex: string[];
  expiresAtMs: number;
}
interface UploadRecord { request:UploadRequest; createdAtMs:number; state:'quarantined'|'ready'|'expired'; lengths:Map<number,number> }
export interface IngestionLimits { maxObjectBytes:number; maxChunkBytes:number; maxTenantBytes:number; maxRetentionMs:number }
async function sha256(input:Uint8Array):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(input))),x=>x.toString(16).padStart(2,'0')).join('');}
/** Reference orchestrator: replace memory state with durable transactions for deployment. */
export class IngestionManager {
  private readonly uploads=new Map<string,UploadRecord>();
  private readonly objectOwners=new Set<string>();
  private readonly queues=new Map<string,Promise<unknown>>();
  private readonly limits:IngestionLimits;
  constructor(private readonly store:CiphertextStore,limits:IngestionLimits){
    this.limits={...limits};
    integer(limits.maxObjectBytes,16,1024*1024*1024);integer(limits.maxChunkBytes,16,8*1024*1024+16);
    integer(limits.maxTenantBytes,limits.maxObjectBytes);integer(limits.maxRetentionMs,1,30*24*60*60*1000);
  }
  private key(scope:IdentityScope,id:string):string{return canonicalJson({tenantId:scope.tenantId,application:scope.application,uploadId:id});}
  private locator(r:UploadRecord,index:number):string{return `${r.request.scope.application}:${r.request.scope.tenantId}:${r.request.storageObjectId}:${index}`;}
  private async locked<T>(key:string,work:()=>Promise<T>):Promise<T>{
    const previous=this.queues.get(key)??Promise.resolve();
    const current=previous.catch(()=>undefined).then(work);this.queues.set(key,current);
    try{return await current;}finally{if(this.queues.get(key)===current)this.queues.delete(key);}
  }
  private record(actor:AuthenticatedActor,scope:IdentityScope,uploadId:string,nowMs:number):UploadRecord{
    requireAccess(actor,scope,'assets:write',nowMs);const r=this.uploads.get(this.key(scope,uploadId));
    invariant(r&&canonicalJson(r.request.scope)===canonicalJson(scope),'UNKNOWN_UPLOAD');
    invariant(r.state!=='expired'&&r.request.expiresAtMs>nowMs,'UPLOAD_EXPIRED');return r;
  }
  begin(actor:AuthenticatedActor,request:UploadRequest,nowMs:number){
    const r=structuredClone(request);requireAccess(actor,r.scope,'assets:write',nowMs);
    invariant(Object.keys(r).sort().join(',')==='chunkDigestsHex,ciphertextSizeBytes,expiresAtMs,scope,storageObjectId,uploadId','UNKNOWN_UPLOAD_FIELDS');
    identifier(r.uploadId);identifier(r.storageObjectId);identifier(r.scope.tenantId);
    integer(r.ciphertextSizeBytes,16,this.limits.maxObjectBytes);integer(r.expiresAtMs,nowMs+1,nowMs+this.limits.maxRetentionMs);
    invariant(r.chunkDigestsHex.length>=1&&r.chunkDigestsHex.length<=4096&&r.chunkDigestsHex.length*16<=r.ciphertextSizeBytes&&r.ciphertextSizeBytes<=r.chunkDigestsHex.length*this.limits.maxChunkBytes,'INVALID_CHUNK_COUNT');
    invariant(r.chunkDigestsHex.every(x=>/^[0-9a-f]{64}$/.test(x)),'INVALID_CHUNK_DIGEST');
    const key=this.key(r.scope,r.uploadId);const existing=this.uploads.get(key);
    if(existing){invariant(canonicalJson(existing.request)===canonicalJson(r)&&existing.state!=='expired','UPLOAD_ID_CONFLICT');return this.progress(r.scope,r.uploadId);}
    const objectKey=this.key(r.scope,r.storageObjectId);invariant(!this.objectOwners.has(objectKey),'OBJECT_ID_REUSE');
    const reserved=[...this.uploads.values()].filter(x=>x.request.scope.tenantId===r.scope.tenantId&&x.state!=='expired').reduce((sum,x)=>sum+x.request.ciphertextSizeBytes,0);
    invariant(reserved+r.ciphertextSizeBytes<=this.limits.maxTenantBytes,'TENANT_QUOTA_EXCEEDED');
    this.objectOwners.add(objectKey);this.uploads.set(key,{request:r,createdAtMs:nowMs,state:'quarantined',lengths:new Map()});return this.progress(r.scope,r.uploadId);
  }
  progress(scope:IdentityScope,uploadId:string){
    const r=this.uploads.get(this.key(scope,uploadId));invariant(r&&canonicalJson(r.request.scope)===canonicalJson(scope),'UNKNOWN_UPLOAD');
    return {state:r.state,receivedIndices:[...r.lengths.keys()].sort((a,b)=>a-b),ciphertextBytes:[...r.lengths.values()].reduce((a,b)=>a+b,0)};
  }
  async putChunk(actor:AuthenticatedActor,scope:IdentityScope,uploadId:string,index:number,ciphertext:Uint8Array,nowMs:number):Promise<void>{
    const bytes=Uint8Array.from(ciphertext);integer(bytes.length,16,this.limits.maxChunkBytes);
    await this.locked(this.key(scope,uploadId),async()=>{
      const r=this.record(actor,scope,uploadId,nowMs);integer(index,0,r.request.chunkDigestsHex.length-1);
      invariant(await sha256(bytes)===r.request.chunkDigestsHex[index],'CHUNK_DIGEST_MISMATCH');
      if(r.lengths.has(index)){
        invariant(r.lengths.get(index)===bytes.length,'CHUNK_SIZE_CONFLICT');return;
      }
      invariant(r.state==='quarantined','UPLOAD_ALREADY_FINALIZED');
      const current=[...r.lengths.values()].reduce((a,b)=>a+b,0);
      invariant(current+bytes.length<=r.request.ciphertextSizeBytes,'UPLOAD_SIZE_EXCEEDED');
      await this.store.put(this.locator(r,index),bytes);r.lengths.set(index,bytes.length);
    });
  }
  async finalize(actor:AuthenticatedActor,scope:IdentityScope,uploadId:string,nowMs:number):Promise<void>{
    await this.locked(this.key(scope,uploadId),async()=>{
      const r=this.record(actor,scope,uploadId,nowMs);
      invariant(r.lengths.size===r.request.chunkDigestsHex.length&&[...r.lengths.values()].reduce((a,b)=>a+b,0)===r.request.ciphertextSizeBytes,'INCOMPLETE_UPLOAD');
      for(let index=0;index<r.request.chunkDigestsHex.length;index++){
        const bytes=await this.store.get(this.locator(r,index));
        invariant(bytes&&bytes.length===r.lengths.get(index)&&await sha256(bytes)===r.request.chunkDigestsHex[index],'STORAGE_CORRUPTION');
      }
      r.state='ready';
    });
  }
  async purgeExpired(nowMs:number):Promise<number>{
    integer(nowMs);let purged=0;
    for(const [key,r] of this.uploads){
      await this.locked(key,async()=>{
        if(r.state==='expired'||r.request.expiresAtMs>nowMs)return;
        for(const index of r.lengths.keys())await this.store.delete(this.locator(r,index));
        r.lengths.clear();r.state='expired';purged++;
      });
    }
    return purged;
  }
}
