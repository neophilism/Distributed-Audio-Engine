import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControlSigningKey,signControl,ControlVerifier,MemoryCheckpointStore,PlaybackAuthority } from '../src/index.js';
import type { ControlBody,LeasePolicy } from '../src/index.js';
const scope={tenantId:'tenant',application:'scenesignal' as const,sessionId:'session'};
async function fixture(policy:LeasePolicy){
  const keys=await createControlSigningKey();const verifier=new ControlVerifier(scope,new Map([['key',keys.publicKey]]),new Set(['lease','emergency-stop']),new MemoryCheckpointStore());
  // This test decoder stands in for the future authenticated E2EE channel.
  const authority=new PlaybackAuthority(verifier,async()=>policy,0.8);
  const body:ControlBody={version:'1.0.0',scope,keyId:'key',algorithm:'ALG-ED25519',epoch:1,sequence:1,issuedAtMs:1000,expiresAtMs:4000,action:'lease',payloadCiphertextBase64:'YWJjZA=='};
  return{keys,authority,body};
}
const policy={expiresAtMs:3000,stopAtMs:5000,fadeMs:1000,maxLinearGain:0.6};
test('lost control authority fades by its deadline and never continues indefinitely',async()=>{
  const f=await fixture(policy);assert.equal(f.authority.gainAt(1000),0);await f.authority.renew(await signControl(f.body,f.keys.privateKey),1000);
  assert.equal(f.authority.gainAt(2000),0.6);assert.equal(f.authority.gainAt(2500),0.3);assert.equal(f.authority.gainAt(3000),0);
});
test('user gain/mute/leave remain immediate controls inside their consented ceiling',async()=>{
  const f=await fixture(policy);await f.authority.renew(await signControl(f.body,f.keys.privateKey),1000);
  f.authority.setUserGain(0.2);assert.equal(f.authority.gainAt(1500),0.2);assert.throws(()=>f.authority.setUserGain(0.9));
  f.authority.mute();assert.equal(f.authority.gainAt(1501),0);f.authority.mute(false);f.authority.leave();assert.equal(f.authority.gainAt(1502),0);
});
test('forged controls, stronger policy and clock rollback cannot extend authority',async()=>{
  const f=await fixture({...policy,maxLinearGain:0.9});await assert.rejects(f.authority.renew(await signControl(f.body,f.keys.privateKey),1000));assert.equal(f.authority.gainAt(1100),0);assert.throws(()=>f.authority.gainAt(1000));
  const g=await fixture(policy);const wrong=await createControlSigningKey();await assert.rejects(g.authority.renew(await signControl(g.body,wrong.privateKey),1000));assert.equal(g.authority.gainAt(1100),0);
});
test('authenticated emergency stop clears the current lease',async()=>{
  const f=await fixture(policy);await f.authority.renew(await signControl(f.body,f.keys.privateKey),1000);
  await f.authority.emergencyStop(await signControl({...f.body,sequence:2,action:'emergency-stop'},f.keys.privateKey),1500);assert.equal(f.authority.gainAt(1501),0);
});
