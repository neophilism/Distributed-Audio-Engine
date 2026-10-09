import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { IngestionManager,MemoryCiphertextStore,encryptAttachment } from '../src/index.js';
const scope={tenantId:'tenant',application:'distributed-radio' as const,identityId:'identity'};
const actor={...scope,deviceId:'device',expiresAtMs:5000,permissions:['assets:write' as const]};
const limits={maxObjectBytes:200000,maxChunkBytes:100000,maxTenantBytes:300000,maxRetentionMs:10000};
async function fixture(){const a=await encryptAttachment(new Uint8Array(70000),{tenantId:'tenant',application:'distributed-radio',parentMessageId:'p',filename:'private.wav',mediaType:'audio/wav'});return{chunks:a.ciphertextChunks,request:{scope,uploadId:'upload',storageObjectId:'object',ciphertextSizeBytes:a.ciphertextChunks.reduce((s,c)=>s+c.length,0),chunkDigestsHex:a.ciphertextChunks.map(c=>createHash('sha256').update(c).digest('hex')),expiresAtMs:3000}};}
test('ciphertext uploads resume, finalize and replay idempotently',async()=>{
  const m=new IngestionManager(new MemoryCiphertextStore(),limits);const f=await fixture();m.begin(actor,f.request,1000);
  await m.putChunk(actor,scope,'upload',1,f.chunks[1]!,1200);await assert.rejects(m.finalize(actor,scope,'upload',1300));
  await Promise.all([m.putChunk(actor,scope,'upload',0,f.chunks[0]!,1400),m.putChunk(actor,scope,'upload',0,f.chunks[0]!,1400)]);
  await m.finalize(actor,scope,'upload',1500);await m.finalize(actor,scope,'upload',1500);
  assert.equal(m.progress(scope,'upload').state,'ready');assert.equal(m.begin(actor,f.request,1600).state,'ready');
});
test('corruption, conflicting metadata and wrong scope cannot finalize',async()=>{
  const store=new MemoryCiphertextStore();const m=new IngestionManager(store,limits);const f=await fixture();m.begin(actor,f.request,1000);
  const bad=Uint8Array.from(f.chunks[0]!);bad[0]=bad[0]!^1;await assert.rejects(m.putChunk(actor,scope,'upload',0,bad,1100));
  assert.throws(()=>m.begin(actor,{...f.request,ciphertextSizeBytes:f.request.ciphertextSizeBytes+1},1100));
  await assert.rejects(m.putChunk({...actor,tenantId:'other'},scope,'upload',0,f.chunks[0]!,1100));
  for(let i=0;i<f.chunks.length;i++)await m.putChunk(actor,scope,'upload',i,f.chunks[i]!,1200);
  await store.put('distributed-radio:tenant:object:0',bad);await assert.rejects(m.finalize(actor,scope,'upload',1300));
});
test('quota reservations count incomplete uploads and expiry purges before reuse',async()=>{
  const m=new IngestionManager(new MemoryCiphertextStore(),{...limits,maxTenantBytes:200000});const f=await fixture();m.begin(actor,f.request,1000);
  m.begin(actor,{...f.request,uploadId:'two',storageObjectId:'two'},1000);
  assert.throws(()=>m.begin(actor,{...f.request,uploadId:'three',storageObjectId:'three'},1000));
  await m.putChunk(actor,scope,'upload',0,f.chunks[0]!,1200);assert.equal(await m.purgeExpired(3000),2);
  await assert.rejects(m.putChunk(actor,scope,'upload',1,f.chunks[1]!,3000));
  m.begin(actor,{...f.request,uploadId:'three',storageObjectId:'three',expiresAtMs:4000},3001);
});
test('storage API accepts no private manifests and retention cannot exceed the pinned profile',async()=>{
  const m=new IngestionManager(new MemoryCiphertextStore(),limits);const f=await fixture();
  assert.throws(()=>m.begin(actor,{...f.request,privateManifest:'secret'} as typeof f.request,1000));
  assert.throws(()=>new IngestionManager(new MemoryCiphertextStore(),{...limits,maxRetentionMs:31*24*60*60*1000}));
});
