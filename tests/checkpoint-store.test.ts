import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { canonicalJson, ControlVerifier, createControlSigningKey, signControl } from '../src/index.js';
import { SqliteCheckpointStore } from '../src/node/index.js';
import type { ControlBody } from '../src/index.js';
const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, sessionId: 'session' }; const key = canonicalJson(scope);
test('durable signed control replay protection survives closing and reopening the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dae-checkpoints-')); const path = join(dir, 'checkpoints.sqlite'); const keys = await createControlSigningKey();
  const body: ControlBody = { version: '1.0.0', scope, keyId: 'key', algorithm: 'ALG-ED25519', epoch: 1, sequence: 1, issuedAtMs: 1000, expiresAtMs: 3000, action: 'lease', payloadCiphertextBase64: 'YWJjZA==' };
  try {
    let store = new SqliteCheckpointStore(path); let verifier = new ControlVerifier(scope, new Map([['key', keys.publicKey]]), new Set(['lease']), store);
    const signed = await signControl(body, keys.privateKey); await verifier.accept(signed, 1000); store.close();
    store = new SqliteCheckpointStore(path); verifier = new ControlVerifier(scope, new Map([['key', keys.publicKey]]), new Set(['lease']), store);
    await assert.rejects(verifier.accept(signed, 1001), /REPLAY_OR_GAP/); await verifier.accept(await signControl({ ...body, sequence: 2 }, keys.privateKey), 1001); assert.deepEqual(store.read(key), { epoch: 1, sequence: 2 }); store.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('compare-and-set rejects stale expectations, sequence gaps and epoch rollback without mutation', () => {
  const store = new SqliteCheckpointStore(':memory:');
  try {
    assert.equal(store.compareAndSet(key, undefined, { epoch: 1, sequence: 2 }), false);
    assert.equal(store.compareAndSet(key, undefined, { epoch: 1, sequence: 1 }), true);
    assert.equal(store.compareAndSet(key, undefined, { epoch: 1, sequence: 1 }), false);
    assert.equal(store.compareAndSet(key, { epoch: 1, sequence: 1 }, { epoch: 1, sequence: 3 }), false);
    assert.equal(store.compareAndSet(key, { epoch: 1, sequence: 1 }, { epoch: 2, sequence: 1 }), true);
    assert.equal(store.compareAndSet(key, { epoch: 2, sequence: 1 }, { epoch: 1, sequence: 1 }), false);
    assert.deepEqual(store.read(key), { epoch: 2, sequence: 1 });
    const output = store.read(key)!; output.sequence = 99; assert.equal(store.read(key)!.sequence, 1);
  } finally { store.close(); }
});
test('canonical scoped counters isolate sessions and reject malformed/extra metadata', () => {
  const store = new SqliteCheckpointStore(':memory:');
  try {
    store.compareAndSet(key, undefined, { epoch: 1, sequence: 1 }); assert.equal(store.read(canonicalJson({ ...scope, sessionId: 'other' })), undefined);
    for (const bad of ['plain-secret-key', JSON.stringify(scope), canonicalJson({ ...scope, privateManifest: 'forbidden' }), canonicalJson({ ...scope, application: 'other' })]) assert.throws(() => store.read(bad));
    assert.throws(() => store.compareAndSet(key, { epoch: 1, sequence: 1 }, { epoch: 2, sequence: 0 }));
  } finally { store.close(); }
  assert.throws(() => store.read(key), /CLOSED/);
});
test('two independent Node processes racing one durable counter commit exactly once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dae-checkpoint-race-')); const path = join(dir, 'checkpoints.sqlite');
  try {
    const initial = new SqliteCheckpointStore(path); initial.close();
    const moduleUrl = pathToFileURL(join(process.cwd(), 'dist/src/node/index.js')).href;
    const script = `import { SqliteCheckpointStore } from ${JSON.stringify(moduleUrl)}; const store = new SqliteCheckpointStore(process.argv[1]); const result = store.compareAndSet(process.argv[2], undefined, { epoch: 1, sequence: 1 }); store.close(); process.stdout.write(String(result));`;
    const child = () => new Promise<string>((resolve, reject) => {
      const proc = spawn(process.execPath, ['--input-type=module', '-e', script, path, key]); let output = ''; let errors = '';
      proc.stdout.on('data', data => { output += String(data); }); proc.stderr.on('data', data => { errors += String(data); }); proc.on('error', reject); proc.on('exit', code => code === 0 ? resolve(output) : reject(new Error(errors)));
    });
    assert.deepEqual((await Promise.all([child(), child()])).sort(), ['false', 'true']);
    const final = new SqliteCheckpointStore(path); assert.deepEqual(final.read(key), { epoch: 1, sequence: 1 }); final.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('checkpoint persistence has no signed-control ciphertext, signature or media key columns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dae-checkpoint-boundary-')); const path = join(dir, 'checkpoints.sqlite');
  try {
    const store = new SqliteCheckpointStore(path); store.compareAndSet(key, undefined, { epoch: 1, sequence: 1 }); store.close(); const file = await readFile(path);
    for (const forbidden of ['payloadCiphertextBase64', 'signatureHex', 'attachmentKeyHex', 'privateManifest']) assert.equal(file.includes(Buffer.from(forbidden)), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
