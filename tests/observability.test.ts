import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeEngineSignals } from '../src/index.js';
import type { EngineSignal } from '../src/index.js';
const a: EngineSignal={componentId:'node-a',observedAtMs:1000,status:'healthy',activeSessions:2,errorCount:0,costMinor:'10',currency:'USD'};
test('health snapshots sum only trusted, fresh complete observations',()=>{
 const report=summarizeEngineSignals([a,{...a,componentId:'node-b',costMinor:'20',activeSessions:3,errorCount:2}],1200,500);
 assert.equal(report.health,'healthy');assert.equal(report.freshness,'fresh');assert.equal(report.activeSessions,5);assert.equal(report.errors,2);
 assert.deepEqual(report.costMinorByCurrency,[{currency:'USD',amountMinor:'30'}]);
});
test('stale, absent, and unknown observations cannot masquerade as healthy zeroes',()=>{
 const stale=summarizeEngineSignals([a],2000,500);
 assert.equal(stale.health,'unknown');assert.equal(stale.activeSessions,null);assert.equal(stale.errors,null);assert.deepEqual(stale.costMinorByCurrency,[]);
 const empty=summarizeEngineSignals([],2000,500);assert.equal(empty.freshness,'unobserved');assert.equal(empty.health,'unknown');
 const partial=summarizeEngineSignals([{...a,activeSessions:null,costMinor:null,currency:null}],1200,500);
 assert.equal(partial.activeSessions,null);assert.deepEqual(partial.costMinorByCurrency,[]);
 const down=summarizeEngineSignals([{...a,status:'unavailable'}],1200,500);assert.equal(down.health,'unavailable');
});
test('unknown fields, duplicate components, future times and bad costs reject',()=>{
 assert.throws(()=>summarizeEngineSignals([a,a],1200,500),/DUPLICATE_ENGINE_COMPONENT/);
 assert.throws(()=>summarizeEngineSignals([a],900,500),/FUTURE_ENGINE_SIGNAL/);
 assert.throws(()=>summarizeEngineSignals([{...a,secret:'key'} as EngineSignal],1200,500),/INVALID_ENGINE_SIGNAL_FIELDS/);
 assert.throws(()=>summarizeEngineSignals([{...a,costMinor:'-2'}],1200,500),/INVALID_ENGINE_COST/);
 assert.throws(()=>summarizeEngineSignals([{...a,currency:null}],1200,500),/INVALID_ENGINE_COST/);
});
