import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RightsCatalog } from '../src/index.js';
import type { RightsGrant,RightsRequest } from '../src/index.js';
const scope={tenantId:'tenant',application:'scenesignal' as const,identityId:'identity'};
const actor={...scope,deviceId:'device',expiresAtMs:10000,permissions:['rights:write' as const]};
function grant(id:string,layer:RightsGrant['layer']):RightsGrant{return{id,assetId:'asset',layer,uses:['stream','cache'],territories:['US'],validFromMs:1000,validUntilMs:5000,authorizationEvidenceRef:'sha256:'+'a'.repeat(64),revoked:false};}
const request:RightsRequest={assetId:'asset',layers:['recording','composition'],uses:['stream','cache'],territory:'US',atMs:2000};
test('recording permission never silently substitutes for composition permission',()=>{
  const c=new RightsCatalog(scope);c.add(actor,grant('recording','recording'),1000);assert.equal(c.evaluate(request).allowed,false);
  c.add(actor,grant('composition','composition'),1000);assert.deepEqual(c.evaluate(request),{allowed:true,grantIds:['composition','recording']});
});
test('territory, selected use, expiry and revocation gate new delivery',()=>{
  const c=new RightsCatalog(scope);c.add(actor,grant('r','recording'),1000);c.add(actor,grant('c','composition'),1000);
  for(const r of [{...request,territory:'FR'},{...request,uses:['sale' as const]},{...request,atMs:5000},{...request,atMs:999}])assert.equal(c.evaluate(r).allowed,false);
  c.revoke(actor,'r',2100);assert.equal(c.evaluate({...request,atMs:2200}).allowed,false);
});
test('spoken works use the same reusable evaluator without music assumptions',()=>{
  const c=new RightsCatalog(scope);c.add(actor,grant('documentary','spoken-work'),1000);
  assert.equal(c.evaluate({...request,layers:['spoken-work']}).allowed,true);
});
test('unknown permissions, unauthorized updates and missing evidence fail closed',()=>{
  const c=new RightsCatalog(scope);assert.throws(()=>c.add({...actor,tenantId:'other'},grant('r','recording'),1000));
  assert.throws(()=>c.add(actor,{...grant('r','recording'),authorizationEvidenceRef:''},1000));
  assert.throws(()=>c.evaluate({...request,uses:[]}));assert.throws(()=>c.evaluate({...request,layers:[]}));
});
