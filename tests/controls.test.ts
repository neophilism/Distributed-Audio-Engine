import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControlSigningKey, signControl, ControlVerifier, MemoryCheckpointStore } from '../src/index.js';
import type { ControlBody } from '../src/index.js';
const scope = {tenantId:'tenant', application:'scenesignal' as const, sessionId:'session'};
function body(overrides: Partial<ControlBody> = {}): ControlBody {
  return {version:'1.0.0',scope,keyId:'key',algorithm:'ALG-ED25519',epoch:1,sequence:1,issuedAtMs:1000,expiresAtMs:2000,action:'fade',payloadCiphertextBase64:'YWJjZA==',...overrides};
}
test('authorized controls authenticate before execution and replay persists across verifier restarts', async () => {
  const keys=await createControlSigningKey(); const store=new MemoryCheckpointStore();
  const signers=new Map([['key', keys.publicKey]]);
  const a=new ControlVerifier(scope,signers,new Set(['fade']),store);
  const c=await signControl(body(),keys.privateKey);
  assert.equal((await a.accept(c,1500)).action,'fade');
  const b=new ControlVerifier(scope,signers,new Set(['fade']),store);
  await assert.rejects(b.accept(c,1500));
  await b.accept(await signControl(body({sequence:2}),keys.privateKey),1500);
});
test('forgery, scope, expiry and unauthorized actions reject without consuming sequence', async () => {
  const keys=await createControlSigningKey(); const wrong=await createControlSigningKey();
  const v=new ControlVerifier(scope,new Map([['key',keys.publicKey]]),new Set(['fade']),new MemoryCheckpointStore());
  const c=await signControl(body(),keys.privateKey);
  await assert.rejects(v.accept(await signControl(body(),wrong.privateKey),1500));
  await assert.rejects(v.accept(await signControl(body({scope:{...scope,tenantId:'other'}}),keys.privateKey),1500));
  await assert.rejects(v.accept(await signControl(body({scope:{...scope,application:'distributed-radio'}}),keys.privateKey),1500));
  await assert.rejects(v.accept(c,2000)); await assert.rejects(v.accept(c,999));
  await assert.rejects(v.accept(await signControl(body({action:'raise-volume'}),keys.privateKey),1500));
  await v.accept(c,1500);
});
test('simultaneous duplicates cannot both commit and old epochs/gaps are rejected', async () => {
  const keys=await createControlSigningKey();
  const v=new ControlVerifier(scope,new Map([['key',keys.publicKey]]),new Set(['fade']),new MemoryCheckpointStore());
  const c=await signControl(body(),keys.privateKey);
  const results=await Promise.allSettled([v.accept(c,1500),v.accept(c,1500)]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
  await assert.rejects(v.accept(await signControl(body({sequence:3}),keys.privateKey),1500));
  await v.accept(await signControl(body({epoch:2}),keys.privateKey),1500);
  await assert.rejects(v.accept(await signControl(body({epoch:1,sequence:2}),keys.privateKey),1500));
});
test('payload mutation invalidates signature and source mutation after signing is isolated', async () => {
  const keys=await createControlSigningKey();const original=body();const c=await signControl(original,keys.privateKey);
  original.scope={...scope,tenantId:'other'};
  const v=new ControlVerifier(scope,new Map([['key',keys.publicKey]]),new Set(['fade']),new MemoryCheckpointStore());
  await assert.rejects(v.accept({...c,body:{...c.body,payloadCiphertextBase64:'ZWZnaA=='}},1500));
  await v.accept(c,1500);
});

test('durable intake authentication does not consume or bypass execution replay checkpoints', async () => {
  const { authenticateControl } = await import('../src/index.js');
  const keys = await createControlSigningKey(), store = new MemoryCheckpointStore();
  const policy = { scope, signers: new Map([['key', keys.publicKey]]), actions: new Set(['fade']) };
  const verifier = new ControlVerifier(scope, policy.signers, policy.actions, store);
  const control = await signControl(body(), keys.privateKey);
  await authenticateControl(control, policy, 1500); await authenticateControl(control, policy, 1500);
  await verifier.accept(control, 1500);
  await authenticateControl(control, policy, 1500);
  await assert.rejects(verifier.accept(control, 1500), /REPLAY_OR_GAP/);
  const gap = await signControl(body({ sequence: 9 }), keys.privateKey);
  assert.equal((await authenticateControl(gap, policy, 1500)).sequence, 9);
  await assert.rejects(verifier.accept(gap, 1500), /REPLAY_OR_GAP/);
});

test('standalone control authentication retains scope, signer, action and lifetime bounds', async () => {
  const { authenticateControl } = await import('../src/index.js');
  const keys = await createControlSigningKey(), wrong = await createControlSigningKey();
  const policy = { scope, signers: new Map([['key', keys.publicKey]]), actions: new Set(['fade']) };
  const control = await signControl(body(), keys.privateKey);
  await assert.rejects(authenticateControl(control, { ...policy, maxLifetimeMs: 999 }, 1500));
  await assert.rejects(authenticateControl(control, { ...policy, maxLifetimeMs: 300001 }, 1500));
  await assert.rejects(authenticateControl(control, { ...policy, actions: new Set() }, 1500));
  await assert.rejects(authenticateControl(control, { ...policy, signers: new Map([['key', wrong.publicKey]]) }, 1500));
  await assert.rejects(authenticateControl(control, { ...policy, scope: { ...scope, sessionId: 'other' } }, 1500));
  await assert.rejects(authenticateControl(control, policy, 2000));
  await authenticateControl(control, policy, 1500);
});

test('standalone control authentication snapshots its envelope across asynchronous verification', async () => {
  const { authenticateControl } = await import('../src/index.js');
  const keys = await createControlSigningKey();
  const control = await signControl(body(), keys.privateKey);
  const pending = authenticateControl(control, { scope, signers: new Map([['key', keys.publicKey]]), actions: new Set(['fade']) }, 1500);
  control.body.sequence = 91; control.signatureHex = '0'.repeat(128);
  assert.equal((await pending).sequence, 1);
});
