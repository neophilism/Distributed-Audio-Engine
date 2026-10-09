import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson,encryptAttachment,decryptAttachment,compileProgram,ProgramTimeline,decodeWave,analyzePcm,encodePcm16 } from '../src/index.js';
const context={tenantId:'tenant',application:'distributed-radio' as const,parentMessageId:'parent'};
test('sparse arrays, extra array properties and accessor objects cannot enter signed canonical payloads',()=>{
  assert.throws(()=>canonicalJson(new Array(2)));const array=[1];Object.assign(array,{extra:2});assert.throws(()=>canonicalJson(array));
  assert.throws(()=>canonicalJson(Object.assign(new Array(1),{extra:2})));
  assert.throws(()=>canonicalJson(Object.defineProperty({},'x',{enumerable:true,get:()=>1})));
});
test('configured attachment limits reject allocation claims before copying or decrypting',async()=>{
  const a=await encryptAttachment(new Uint8Array([1,2]),{...context,filename:'x',mediaType:'audio/wav'});
  await assert.rejects(decryptAttachment(a.privateManifest,a.ciphertextChunks,context,1));
  await assert.rejects(encryptAttachment(new Uint8Array(2),{...context,filename:'x',mediaType:'audio/wav',maxPlaintextBytes:1}));
  await assert.rejects(decryptAttachment({...a.privateManifest,plaintextSizeBytes:1e12},a.ciphertextChunks,context));
});
test('late marker queries do not replay loops from obsolete revisions',()=>{
  const clips=[{id:'clip',assetId:'asset',frames:8000,markerAfter:'mark'}];const t=new ProgramTimeline(0,compileProgram('old',8000,clips));
  t.publish(compileProgram('new',8000,clips),8000n,0);
  const results=t.markersBetween(8000n*1000000n,8000n*1000001n);assert.equal(results.length,1);assert.equal(results[0]!.programId,'new');
});
test('bounded malformed waveform and contract corpus rejects safely without unbounded parser work',()=>{
  let seed=123456;
  const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  const seedWave=encodePcm16({sampleRate:48000,channels:1,samples:Float32Array.from({length:64},(_,i)=>Math.sin(i)*0.5)});
  for(let trial=0;trial<2000;trial++){
    let bytes=trial%2===0?Uint8Array.from(seedWave):Uint8Array.from({length:next()%256},()=>next()%256);
    if(trial%2===0){for(let i=0;i<1+trial%8;i++){const at=next()%bytes.length;bytes[at]=next()%256;}if(trial%3===0)bytes=bytes.slice(0,next()%bytes.length);}
    try{const pcm=decodeWave(bytes);analyzePcm(pcm);}catch(error){assert.ok(error instanceof Error);}
  }
  for(let frames=1;frames<=100;frames++){
    const pcm={sampleRate:48000,channels:1,samples:Float32Array.from({length:frames},()=>((next()%65535)-32767)/32768)};
    const decoded=decodeWave(encodePcm16(pcm));assert.equal(analyzePcm(decoded).frames,frames);
  }
});
