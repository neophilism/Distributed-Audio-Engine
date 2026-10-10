import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SponsorAccounting, MemorySponsorStore } from '../src/index.js';
import type { SponsorEvent, SponsorCampaign, AuthenticatedActor } from '../src/index.js';
const scope = { tenantId:'tenant', application:'distributed-radio' as const, identityId:'merchant' };
const manager: AuthenticatedActor = { ...scope, deviceId:'device', expiresAtMs:10000, permissions:['commerce:manage'] };
const campaign: SponsorCampaign = { campaignId:'campaign', creativeIds:['creative'], startsAtMs:100, endsAtMs:2000, maxDeliveries:2, approvalEvidenceRef:'sha256:'+'a'.repeat(64) };
const delivery: SponsorEvent = { scope, eventId:'del1', campaignId:'campaign', creativeId:'creative', occurredAtMs:200, kind:'delivery', deliveryEventId:null, outputEvidenceRef:null };
const proof: SponsorEvent = { ...delivery, eventId:'proof1', occurredAtMs:300, kind:'qualified-output', deliveryEventId:'del1', outputEvidenceRef:'sha256:'+'b'.repeat(64) };
function fixture() {
 let event:SponsorEvent = structuredClone(delivery), valid=true;
 const store = new MemorySponsorStore();
 const accounting = new SponsorAccounting(scope,store,{async verify(){assert.equal(valid,true); return structuredClone(event);}});
 accounting.register(manager,campaign,100);
 return {accounting,store,set(e:SponsorEvent){event=e},invalidate(){valid=false}};
}
const raw = new Uint8Array([1]);
test('sponsor records authenticated deliveries, separately qualified output, and no people inference',async()=>{
 const f=fixture();
 assert.deepEqual(f.accounting.report(manager,'campaign',101),{campaignId:'campaign',deliveredEvents:0,qualifiedOutputEvents:0,peopleCount:null,lastEventAtMs:null});
 const first=await f.accounting.accept(raw,'authenticated',201); assert.equal(first.deliveredEvents,1);
 assert.deepEqual(await f.accounting.accept(raw,'authenticated',201),first);
 f.set(proof);const verified=await f.accounting.accept(raw,'authenticated',301);
 assert.equal(verified.deliveredEvents,1);assert.equal(verified.qualifiedOutputEvents,1);assert.equal(verified.peopleCount,null);
 assert.deepEqual(await f.accounting.accept(raw,'authenticated',301),verified);
 f.set({...proof,eventId:'proof2'});await assert.rejects(f.accounting.accept(raw,'authenticated',310),/SPONSOR_DUPLICATE_QUALIFICATION/);
 assert.equal(f.accounting.report(manager,'campaign',310).qualifiedOutputEvents,1);
});
test('sponsor rejects forged, unbound, changed and cross-scope events',async()=>{
 const f=fixture();
 f.set(proof);await assert.rejects(f.accounting.accept(raw,'ok',400),/SPONSOR_UNBOUND_OUTPUT/);
 f.set({...delivery,scope:{...scope,tenantId:'different'}});await assert.rejects(f.accounting.accept(raw,'ok',400),/SPONSOR_SCOPE_MISMATCH/);
 f.set({...delivery,creativeId:'other'});await assert.rejects(f.accounting.accept(raw,'ok',400),/UNKNOWN_SPONSOR_CREATIVE/);
 f.set(delivery);await f.accounting.accept(raw,'ok',400);
 f.set({...delivery,occurredAtMs:201});await assert.rejects(f.accounting.accept(raw,'ok',400),/SPONSOR_EVENT_CONFLICT/);
 f.invalidate();await assert.rejects(f.accounting.accept(raw,'invalid',400));
 assert.equal(f.accounting.report(manager,'campaign',400).deliveredEvents,1);
});
test('campaign approvals, scope, quotas and transactional rollback fail closed',async()=>{
 const f=fixture();
 assert.throws(()=>f.accounting.register({...manager,identityId:'other'},campaign,100));
 assert.throws(()=>f.accounting.register(manager,{...campaign,maxDeliveries:3},100),/SPONSOR_CAMPAIGN_CONFLICT/);
 f.set({...delivery,occurredAtMs:50});await assert.rejects(f.accounting.accept(raw,'ok',400),/SPONSOR_CAMPAIGN_INACTIVE/);
 f.set(delivery);await f.accounting.accept(raw,'ok',400);
 f.set({...delivery,eventId:'del2'});await f.accounting.accept(raw,'ok',400);
 f.set({...delivery,eventId:'del3'});await assert.rejects(f.accounting.accept(raw,'ok',400),/SPONSOR_DELIVERY_LIMIT/);
 assert.equal(f.accounting.report(manager,'campaign',400).deliveredEvents,2);
 assert.throws(()=>f.store.transact(scope,state=>{state.events.clear();throw Error('rollback')}));
 assert.equal(f.accounting.report(manager,'campaign',400).deliveredEvents,2);
});
