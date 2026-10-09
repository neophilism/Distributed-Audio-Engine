import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CoordinatorChunkTransport, CoordinatorMonitor, ControlVerifier, createControlSigningKey, MemoryCheckpointStore, signControl } from '../src/index.js';
import type { CiphertextChunkTransport, ControlBody, CoordinatorLease } from '../src/index.js';
const scope = { tenantId: 'tenant', application: 'scenesignal' as const, sessionId: 'session' };
const request = { tenantId: scope.tenantId, application: scope.application, storageObjectId: 'object', chunkIndex: 0, expectedBytes: 20 };
async function fixture(lease: CoordinatorLease = { coordinatorId: 'local', programId: 'program', expiresAtMs: 2000, term: 1 }) {
  const keys = await createControlSigningKey(); const verifier = new ControlVerifier(scope, new Map([['key', keys.publicKey]]), new Set(['coordinator-lease']), new MemoryCheckpointStore());
  const monitor = new CoordinatorMonitor(scope, 'program', verifier, async () => lease);
  const body: ControlBody = { version: '1.0.0', scope, keyId: 'key', algorithm: 'ALG-ED25519', epoch: 1, sequence: 1, issuedAtMs: 1000, expiresAtMs: 3000, action: 'coordinator-lease', payloadCiphertextBase64: 'YWJjZA==' };
  return { keys, body, monitor, verifier };
}
test('only a scoped signed primary lease enables the pre-registered local ciphertext transport', async () => {
  const f = await fixture(); let local = 0; let remote = 0;
  const transport = new CoordinatorChunkTransport(f.monitor, new Map([['local', { async read() { local++; return new Uint8Array(20).fill(1); } }]]), { async read() { remote++; return new Uint8Array(20).fill(2); } }, { nowUnixMs: () => 1000 });
  assert.equal((await transport.read(request))[0], 2); await f.monitor.accept(await signControl(f.body, f.keys.privateKey), 1000); assert.equal((await transport.read(request))[0], 1); assert.equal(local, 1); assert.equal(remote, 1);
  await assert.rejects(transport.read({ ...request, tenantId: 'other' }), /SCOPE/);
});
test('missing segments, unknown hosts, wrong lengths and deadlines fall back within a bounded interval', async () => {
  for (const mode of ['missing', 'timeout', 'short', 'unregistered']) {
    const f = await fixture(); await f.monitor.accept(await signControl(f.body, f.keys.privateKey), 1000); let remote = 0; let canceled = false;
    const local: CiphertextChunkTransport = { async read(_request, signal) { if (mode === 'timeout') { signal?.addEventListener('abort', () => { canceled = true; }); return new Promise<Uint8Array>(() => undefined); } if (mode === 'short') return new Uint8Array(19); throw new Error('missing ciphertext'); } };
    const transport = new CoordinatorChunkTransport(f.monitor, mode === 'unregistered' ? new Map() : new Map([['local', local]]), { async read() { remote++; return new Uint8Array(20).fill(3); } }, { nowUnixMs: () => 1000, localTimeoutMs: 5 });
    assert.equal((await transport.read(request))[0], 3); assert.equal(remote, 1); if (mode === 'timeout') assert.equal(canceled, true);
  }
});
test('expired or changed leases discard an in-flight local result and use the common fallback', async () => {
  const f = await fixture(); await f.monitor.accept(await signControl(f.body, f.keys.privateKey), 1000); let now = 1000;
  const transport = new CoordinatorChunkTransport(f.monitor, new Map([['local', { async read() { now = 2000; return new Uint8Array(20).fill(1); } }]]), { async read() { return new Uint8Array(20).fill(2); } }, { nowUnixMs: () => now });
  assert.equal((await transport.read(request))[0], 2); assert.equal(f.monitor.activeAt(2000), undefined);
});
test('cancellation and close stop failover instead of silently creating another transfer', async () => {
  for (const close of [false, true]) {
    const f = await fixture(); await f.monitor.accept(await signControl(f.body, f.keys.privateKey), 1000); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); let remote = 0;
    const transport = new CoordinatorChunkTransport(f.monitor, new Map([['local', { async read() { entered(); return new Promise<Uint8Array>(() => undefined); } }]]), { async read() { remote++; return new Uint8Array(20); } }, { nowUnixMs: () => 1000 });
    const abort = new AbortController(); const promise = transport.read(request, abort.signal); await started; if (close) transport.close(); else abort.abort();
    await assert.rejects(promise, /ABORTED/); assert.equal(remote, 0);
  }
});
test('forged, replayed, cross-scope or invalid lease terms never become active', async () => {
  const f = await fixture(); const wrong = await createControlSigningKey(); await assert.rejects(f.monitor.accept(await signControl(f.body, wrong.privateKey), 1000)); assert.equal(f.monitor.activeAt(1000), undefined);
  await assert.rejects(f.monitor.accept(await signControl({ ...f.body, scope: { ...scope, sessionId: 'other' } }, f.keys.privateKey), 1000));
  await f.monitor.accept(await signControl(f.body, f.keys.privateKey), 1000); await assert.rejects(f.monitor.accept(await signControl(f.body, f.keys.privateKey), 1000));
  const invalid = await fixture({ coordinatorId: 'local', programId: 'program', expiresAtMs: 2000, term: 2 }); await assert.rejects(invalid.monitor.accept(await signControl(invalid.body, invalid.keys.privateKey), 1000), /TERM/);
});
test('disconnect during payload decoding cannot reestablish a prior local lease', async () => {
  const f = await fixture(); let release!: (value: CoordinatorLease) => void; let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const monitor = new CoordinatorMonitor(scope, 'program', f.verifier, async () => { entered(); return new Promise<CoordinatorLease>(resolve => { release = resolve; }); });
  const accepting = monitor.accept(await signControl(f.body, f.keys.privateKey), 1000); await started; monitor.disconnect(); release({ coordinatorId: 'local', programId: 'program', expiresAtMs: 2000, term: 1 }); await assert.rejects(accepting, /SUPERSEDED/); assert.equal(monitor.activeAt(1000), undefined);
});
