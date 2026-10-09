import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createControlSigningKey, DeviceRegistry, signDeviceEvent, requireAccess } from '../src/index.js';
import type { DeviceEventBody, DeviceRecord } from '../src/index.js';
const scope={tenantId:'tenant',application:'distributed-radio' as const,identityId:'identity'};
function device(id:string,generation=1):Omit<DeviceRecord,'status'>{return{id,generation,signing:{id:randomBytes(16).toString('hex'),algorithm:'ALG-ED25519',publicKeyHex:randomBytes(32).toString('hex')},agreement:{id:randomBytes(16).toString('hex'),algorithm:'ALG-X25519',publicKeyHex:randomBytes(32).toString('hex')}};}
async function event(registry:DeviceRegistry,action:DeviceEventBody['action'],deviceId:string,replacement:DeviceEventBody['replacement']){
  return{scope,sequence:registry.snapshot().sequence+1,precedingStateHashHex:await registry.stateHash(),action,deviceId,replacement};
}
test('tenant/application/identity permissions and expiry fail closed',()=>{
  const actor={...scope,deviceId:'device',expiresAtMs:2000,permissions:['assets:write' as const]};
  requireAccess(actor,scope,'assets:write',1000);
  for(const target of [{...scope,tenantId:'other'},{...scope,application:'scenesignal' as const},{...scope,identityId:'other'}])assert.throws(()=>requireAccess(actor,target,'assets:write',1000));
  assert.throws(()=>requireAccess(actor,scope,'program:write',1000));assert.throws(()=>requireAccess(actor,scope,'assets:write',2000));
});
test('only root-authorized state-bound enrollment works; replay and forgery reject',async()=>{
  const root=await createControlSigningKey();const wrong=await createControlSigningKey();const r=new DeviceRegistry(scope,root.publicKey);
  const body=await event(r,'enroll','one',device('one'));const signed=await signDeviceEvent(body,root.privateKey);
  await assert.rejects(r.apply(await signDeviceEvent(body,wrong.privateKey)));await r.apply(signed);
  assert.deepEqual(r.activeRecipients(),['one']);await assert.rejects(r.apply(signed));
  const restored=new DeviceRegistry(scope,root.publicKey);await restored.apply(signed);assert.equal(await r.stateHash(),await restored.stateHash());
});
test('rotation retires keys; revocation excludes devices and last device cannot revoke',async()=>{
  const root=await createControlSigningKey();const r=new DeviceRegistry(scope,root.publicKey);const one=device('one');
  await r.apply(await signDeviceEvent(await event(r,'enroll','one',one),root.privateKey));
  await assert.rejects(r.apply(await signDeviceEvent(await event(r,'revoke','one',null),root.privateKey)));
  await r.apply(await signDeviceEvent(await event(r,'enroll','two',device('two')),root.privateKey));
  await r.apply(await signDeviceEvent(await event(r,'rotate','one',device('one',2)),root.privateKey));
  await r.apply(await signDeviceEvent(await event(r,'revoke','two',null),root.privateKey));
  assert.equal(r.isActive('two'),false);assert.deepEqual(r.activeRecipients(),['one']);
  await assert.rejects(r.apply(await signDeviceEvent(await event(r,'enroll','two',device('two')),root.privateKey)));
  await assert.rejects(r.apply(await signDeviceEvent(await event(r,'rotate','one',{...one,generation:3}),root.privateKey)));
});
test('simultaneous state transitions commit one state and external snapshots cannot mutate registry',async()=>{
  const root=await createControlSigningKey();const r=new DeviceRegistry(scope,root.publicKey);const b=await event(r,'enroll','one',device('one'));const signed=await signDeviceEvent(b,root.privateKey);
  const results=await Promise.allSettled([r.apply(signed),r.apply(signed)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  r.snapshot().devices[0]!.status='revoked';assert.equal(r.isActive('one'),true);
});
