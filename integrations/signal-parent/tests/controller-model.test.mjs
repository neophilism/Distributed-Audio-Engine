import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DurableSignalController } from '../src/controller.mjs';
import { EncryptedFileVault } from '../src/vault.mjs';

const recipient = 'b'.repeat(64), scope = { tenantId: 'tenant', application: 'distributed-radio', sessionId: 'session' };
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dae-controller-')); chmodSync(directory, 0o700);
  const key = randomBytes(32), vault = new EncryptedFileVault({ directory, key, binding: { test: 'controller' } });
  let now = 100000, denied = false, encryptions = 0, pause, failAfter = false;
  const packets = new Map(), calls = [];
  const channel = {
    publicIdentity: { scope, identityId: 'owner', address: 'a'.repeat(64), device: { signing: { id: 'signing-key' } } },
    requirePeer() { if (denied) throw Error('PEER_REVOKED'); return { identityId: 'listener', expiresAtMs: 999999 }; },
    async queueControl(to, fields, payload, { messageId }) {
      calls.push({ to, fields: structuredClone(fields), payload: structuredClone(payload), messageId });
      assert.equal(vault.read('controller-state').value.operations.find(o => o.operationId === messageId)?.sequence, fields.sequence);
      if (pause) await pause();
      if (!packets.has(messageId)) {
        encryptions++;
        packets.set(messageId, { recipient: to, kind: 'control', status: 'pending', packet: { deliveryId: messageId,
          recordType: 'control', expiresAtMs: fields.expiresAtMs, record: { signatureHex: 'a'.repeat(128), body: {
            version: '1.0.0', scope, keyId: 'signing-key', algorithm: 'ALG-ED25519', ...fields,
            payloadCiphertextBase64: Buffer.from('model-ciphertext-' + encryptions).toString('base64') } } } });
      }
      if (failAfter) throw Error('UNCERTAIN_DELIVERY');
      return structuredClone(packets.get(messageId));
    }
  };
  const options = { vault, channel, nowUnixMs: () => now };
  let controller = new DurableSignalController(options);
  const request = (operationId = 'operation') => ({ operationId, recipient, action: 'lease', expiresAtMs: now + 3000,
    payload: { expiresAtMs: now + 2000, stopAtMs: now + 2000, fadeMs: 100, maxLinearGain: 0.25 } });
  t.after(() => { controller.close(); vault.close(); key.fill(0); rmSync(directory, { recursive: true, force: true }); });
  return { vault, channel, directory, calls, packets, request, get controller() { return controller; },
    reopen() { controller.close(); controller = new DurableSignalController(options); return controller; },
    get encryptions() { return encryptions; }, get now() { return now; }, setNow(n) { now = n; }, deny() { denied = true; },
    pause(fn) { pause = fn; }, failAfter(value) { failAfter = value; } };
}

test('controller model: persist intent before external signing and advance only durable counters', async t => {
  const p = setup(t); const first = await p.controller.issue(p.request());
  assert.equal(first.packet.record.body.sequence, 1); assert.equal(first.packet.record.body.epoch, 1);
  assert.deepEqual(p.controller.pending(), []);
  assert.equal(p.controller.streamState(recipient).sequence, 1);
  assert.equal(readFileSync(join(p.directory, 'signal.vault')).includes(Buffer.from('maxLinearGain')), false);
  const second = await p.controller.issue(p.request('next'));
  assert.equal(second.packet.record.body.sequence, 2);
});
test('controller model: retries and reopen retain exact ID, counters, private payload and packet', async t => {
  const p = setup(t), request = p.request(); const first = await p.controller.issue(request);
  p.setNow(p.now + 1); p.reopen();
  assert.deepEqual(await p.controller.resume(request.operationId), first);
  assert.deepEqual(await p.controller.issue(request), first); assert.equal(p.encryptions, 1);
  assert.equal(p.calls.every(call => call.fields.issuedAtMs === 100000), true);
});
test('controller model: conflicting operation IDs cannot change payload, recipient, action or expiry', async t => {
  const p = setup(t), request = p.request(); await p.controller.issue(request);
  for (const patch of [{ recipient: 'c'.repeat(64) }, { expiresAtMs: request.expiresAtMs + 1 },
    { payload: { ...request.payload, maxLinearGain: 0.3 } }, { action: 'emergency-stop', payload: null }])
    await assert.rejects(p.controller.issue({ ...request, ...patch }), /OPERATION_ID_CONFLICT/);
  assert.equal(p.encryptions, 1); assert.equal(p.controller.streamState(recipient).sequence, 1);
});
test('controller model: failed signing reserves the sequence and blocks a new ID until explicit resume', async t => {
  const p = setup(t); p.pause(() => { throw Error('SIGNING_FAILED'); });
  await assert.rejects(p.controller.issue(p.request()), /SIGNING_FAILED/);
  assert.equal(p.controller.pending()[0].operationId, 'operation');
  assert.equal('payload' in p.controller.pending()[0], false);
  await assert.rejects(p.controller.issue(p.request('next')), /RESUME_OR_NEW_EPOCH_REQUIRED/);
  p.pause(undefined); p.reopen(); const result = await p.controller.resume('operation');
  assert.equal(result.packet.record.body.sequence, 1); assert.equal(p.encryptions, 1);
});
test('controller model: uncertain external commit resumes byte-identical rather than creating a second command', async t => {
  const p = setup(t); p.failAfter(true);
  await assert.rejects(p.controller.issue(p.request()), /UNCERTAIN_DELIVERY/);
  const committed = p.packets.get('operation'); p.failAfter(false); p.reopen();
  assert.deepEqual(await p.controller.resume('operation'), committed); assert.equal(p.encryptions, 1);
});
test('controller model: uncertain reservation commit is recovered without ever releasing unpersisted authority', async t => {
  const p = setup(t), write = p.vault.compareAndSet.bind(p.vault); let fail = true;
  p.vault.compareAndSet = (...args) => { const result = write(...args); if (fail) throw Error('LOST_FSYNC_RESULT'); return result; };
  await assert.rejects(p.controller.issue(p.request()), /LOST_FSYNC_RESULT/);
  assert.equal(p.calls.length, 0); fail = false; p.reopen();
  assert.equal((await p.controller.resume('operation')).packet.record.body.sequence, 1);
});
test('controller model: failure after ciphertext persistence leaves recoverable intent and no false completion', async t => {
  const p = setup(t), write = p.vault.compareAndSet.bind(p.vault); let fail = true;
  p.vault.compareAndSet = (name, revision, value) =>
    fail && value.operations.some(o => o.status === 'queued') ? false : write(name, revision, value);
  await assert.rejects(p.controller.issue(p.request()), /STATE_CONFLICT/);
  assert.equal(p.controller.pending().length, 1); assert.equal(p.encryptions, 1); fail = false;
  assert.deepEqual(await p.controller.resume('operation'), p.packets.get('operation'));
  assert.deepEqual(p.controller.pending(), []);
});
test('controller model: a fresh explicit epoch supersedes uncertain work without resetting the counter stream', async t => {
  const p = setup(t); p.pause(() => { throw Error('SIGNING_FAILED'); });
  await assert.rejects(p.controller.issue(p.request()), /SIGNING_FAILED/); p.pause(undefined);
  assert.throws(() => p.controller.advanceEpoch(recipient, 0), /EPOCH_CONFLICT/);
  assert.deepEqual({ ...p.controller.advanceEpoch(recipient, 1) }, { epoch: 2, sequence: 0 });
  await assert.rejects(p.controller.resume('operation'), /EPOCH_SUPERSEDED/);
  const next = await p.controller.issue(p.request('fresh'));
  assert.equal(next.packet.record.body.epoch, 2); assert.equal(next.packet.record.body.sequence, 1);
});
test('controller model: expiry cannot erase an unresolved reservation or implicitly invent a fresh lease', async t => {
  const p = setup(t); p.pause(() => { throw Error('SIGNING_FAILED'); });
  await assert.rejects(p.controller.issue(p.request()), /SIGNING_FAILED/); p.pause(undefined); p.setNow(p.now + 4000);
  assert.equal(p.controller.pending()[0].expired, true);
  await assert.rejects(p.controller.resume('operation'), /OPERATION_EXPIRED/);
  await assert.rejects(p.controller.issue(p.request('new')), /RESUME_OR_NEW_EPOCH_REQUIRED/);
  p.controller.advanceEpoch(recipient, 1);
  assert.equal((await p.controller.issue(p.request('new'))).packet.record.body.epoch, 2);
});
test('controller model: late completion after epoch advancement cannot finalize superseded work', async t => {
  const p = setup(t); let finish; p.pause(() => new Promise(resolve => { finish = resolve; }));
  const pending = p.controller.issue(p.request()), rejection = assert.rejects(pending, /EPOCH_SUPERSEDED/);
  p.controller.advanceEpoch(recipient, 1); finish(); await rejection;
  assert.equal(p.controller.streamState(recipient).epoch, 2); assert.equal(p.controller.streamState(recipient).sequence, 0);
});
test('controller model: one in-flight operation per controller and caller mutation cannot alter saved intent', async t => {
  const p = setup(t); let finish; p.pause(() => new Promise(resolve => { finish = resolve; }));
  const request = p.request(), pending = p.controller.issue(request); request.payload.maxLinearGain = 1;
  await assert.rejects(p.controller.issue(p.request('other')), /CONTROLLER_BUSY/); finish(); await pending;
  assert.equal(p.calls[0].payload.maxLinearGain, 0.25); assert.equal(p.calls.length, 1);
});
test('controller model: revoke, clock rollback, close and copied identity prevent further issuance', async t => {
  const p = setup(t); await p.controller.issue(p.request()); p.reopen(); p.setNow(p.now - 1);
  await assert.rejects(p.controller.resume('operation'));
  p.setNow(p.now + 1); p.deny(); await assert.rejects(p.controller.resume('operation'), /PEER_REVOKED/);
  p.controller.close(); await assert.rejects(p.controller.resume('operation'), /CONTROLLER_CLOSED/);
  p.channel.publicIdentity = { ...p.channel.publicIdentity, address: 'c'.repeat(64) };
  assert.throws(() => p.reopen(), /BINDING_MISMATCH/);
});
test('controller model: malformed inputs and unsupported payloads leave the store untouched', async t => {
  const p = setup(t), request = p.request();
  for (const patch of [{ extra: true }, { recipient: 'bad' }, { action: 'seek' }, { action: 'emergency-stop' },
    { expiresAtMs: p.now + 60001 }, { payload: { ...request.payload, maxLinearGain: 1.1 } },
    { payload: { ...request.payload, fadeMs: 5000 } }, { payload: { ...request.payload, secret: 'no' } }])
    await assert.rejects(p.controller.issue({ ...request, ...patch }));
  assert.equal(p.vault.read('controller-state'), undefined); assert.equal(p.calls.length, 0);
});
test('controller model: bounded retention never resets sequence numbers or evicts live operations', async t => {
  const p = setup(t);
  for (let i = 0; i < 64; i++) await p.controller.issue(p.request('bounded-' + i));
  await assert.rejects(p.controller.issue(p.request('overflow')), /OPERATION_LIMIT/);
  assert.equal(p.controller.streamState(recipient).sequence, 64);
  p.setNow(p.now + 4000); const next = await p.controller.issue(p.request('after-expiry'));
  assert.equal(next.packet.record.body.sequence, 65); assert.equal(p.vault.read('controller-state').value.operations.length, 1);
});
test('controller model: two instances cannot reserve different commands for the same unresolved sequence', async t => {
  const p = setup(t); let finish; p.pause(() => new Promise(resolve => { finish = resolve; }));
  const other = new DurableSignalController({ vault: p.vault, channel: p.channel, nowUnixMs: () => p.now }); t.after(() => other.close());
  const pending = p.controller.issue(p.request());
  await assert.rejects(other.issue(p.request('racing')), /RESUME_OR_NEW_EPOCH_REQUIRED/); finish(); await pending;
  p.pause(undefined); assert.equal((await other.issue(p.request('racing'))).packet.record.body.sequence, 2);
});
test('controller model: malformed external packet and closing during signing never produce a success receipt', async t => {
  const p = setup(t), original = p.channel.queueControl.bind(p.channel);
  p.channel.queueControl = async (...args) => { const value = await original(...args); value.packet.deliveryId = 'substituted'; return value; };
  await assert.rejects(p.controller.issue(p.request()), /PACKET_MISMATCH/); assert.equal(p.controller.pending().length, 1);
  p.channel.queueControl = original; let finish; p.pause(() => new Promise(resolve => { finish = resolve; }));
  const pending = p.controller.resume('operation'), rejection = assert.rejects(pending, /CONTROLLER_CLOSED/);
  p.controller.close(); finish(); await rejection;
});

test('controller model: resumed leases with insufficient remaining fade time stay stopped', async t => {
  const p = setup(t); p.pause(() => { throw Error('SIGNING_FAILED'); });
  await assert.rejects(p.controller.issue(p.request()), /SIGNING_FAILED/); p.pause(undefined);
  p.setNow(p.now + 1950); assert.equal(p.controller.pending()[0].expired, true);
  await assert.rejects(p.controller.resume('operation'), /OPERATION_EXPIRED/); assert.equal(p.encryptions, 0);
});
test('controller model: peer revocation while signing prevents finalization and receipt', async t => {
  const p = setup(t); let finish; p.pause(() => new Promise(resolve => { finish = resolve; }));
  const pending = p.controller.issue(p.request()), rejection = assert.rejects(pending, /PEER_REVOKED/);
  p.deny(); finish(); await rejection; assert.equal(p.controller.pending().length, 1);
});
test('controller model: corrupt stored counters cannot be silently repaired into authority', async t => {
  const p = setup(t); await p.controller.issue(p.request());
  const row = p.vault.read('controller-state'); row.value.streams[0].sequence = 0;
  assert.equal(p.vault.compareAndSet('controller-state', row.revision, row.value), true);
  assert.throws(() => p.reopen(), /INVALID_COUNTER/);
});
