import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, symlinkSync, linkSync, unlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { EncryptedFileVault, EncryptedCheckpointStore } from '../src/vault.mjs';
import { SignalParentChannel } from '../src/channel.mjs';
import { fixture, scope, ALL } from './helpers.mjs';
function vaultFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dae-vault-')), key = randomBytes(32);
  const options = { directory, key, binding: { endpoint: 'recipient' } };
  const vault = new EncryptedFileVault(options), path = join(directory, 'signal.vault');
  t.after(() => { vault.close(); key.fill(0); rmSync(directory, { recursive: true, force: true }); });
  return { vault, options, path, directory };
}

test('encrypted atomic snapshots persist across reopen and never write private values in cleartext', t => {
  const f = vaultFixture(t); const secret = randomBytes(32).toString('base64');
  assert.equal(f.vault.compareAndSet('identity', undefined, { secret }), true);
  const bytes = readFileSync(f.path);
  assert.equal(bytes.includes(Buffer.from(secret)), false); assert.equal(statSync(f.path).mode & 0o777, 0o600);
  const revision = f.vault.revision; f.vault.close();
  const next = new EncryptedFileVault({ ...f.options, minimumRevision: revision });
  try { assert.equal(next.read('identity').value.secret, secret); assert.equal(next.revision, revision); }
  finally { next.close(); }
});

test('vault rejects altered ciphertext, headers, wrong keys and endpoint-binding substitution', t => {
  const f = vaultFixture(t); f.vault.compareAndSet('identity', undefined, { secret: 'private' });
  const original = readFileSync(f.path);
  for (const offset of [0, 8, 20, 36, original.length - 1]) {
    const bad = Buffer.from(original); bad[offset] ^= 1; writeFileSync(f.path, bad);
    assert.throws(() => f.vault.read('identity')); writeFileSync(f.path, original);
  }
  assert.throws(() => new EncryptedFileVault({ ...f.options, key: randomBytes(32) }), /AUTHENTICATION/);
  assert.throws(() => new EncryptedFileVault({ ...f.options, binding: { endpoint: 'another' } }), /AUTHENTICATION/);
});

test('CAS permits one competing update without losing unrelated checkpoint records', t => {
  const f = vaultFixture(t), second = new EncryptedFileVault(f.options); t.after(() => second.close());
  assert.equal(f.vault.compareAndSet('identity', undefined, { n: 1 }), true);
  const version = f.vault.read('identity').revision;
  second.compareAndSet('checkpoints', undefined, { sequence: 2 });
  assert.equal(f.vault.compareAndSet('identity', version, { n: 3 }), true);
  assert.equal(second.compareAndSet('identity', version, { n: 4 }), false);
  assert.equal(second.read('identity').value.n, 3); assert.equal(second.read('checkpoints').value.sequence, 2);
});

test('observed rollback/deletion is rejected and a saved revision floor protects reopen', t => {
  const f = vaultFixture(t); f.vault.compareAndSet('identity', undefined, { n: 1 });
  const earlier = readFileSync(f.path), version = f.vault.read('identity').revision;
  f.vault.compareAndSet('identity', version, { n: 2 }); const floor = f.vault.revision;
  writeFileSync(f.path, earlier); assert.throws(() => f.vault.read('identity'), /ROLLBACK/);
  assert.throws(() => new EncryptedFileVault({ ...f.options, minimumRevision: floor }), /ROLLBACK/);
  unlinkSync(f.path); assert.throws(() => f.vault.read('identity'), /ROLLBACK/);
});

test('unsafe permissions, symbolic links and hard links cannot be used for endpoint secrets', t => {
  const f = vaultFixture(t); f.vault.compareAndSet('identity', undefined, { n: 1 });
  chmodSync(f.path, 0o644); assert.throws(() => f.vault.read('identity'), /UNSAFE_FILE/); chmodSync(f.path, 0o600);
  const hard = join(f.directory, 'hard'); linkSync(f.path, hard);
  assert.throws(() => f.vault.read('identity'), /UNSAFE_FILE/); unlinkSync(hard);
  const data = readFileSync(f.path), target = join(f.directory, 'target');
  unlinkSync(f.path); writeFileSync(target, data, { mode: 0o600 }); symlinkSync(target, f.path);
  assert.throws(() => f.vault.read('identity')); unlinkSync(f.path); writeFileSync(f.path, data, { mode: 0o600 });
  chmodSync(f.directory, 0o755); assert.throws(() => f.vault.read('identity'), /PRIVATE_DIRECTORY/); chmodSync(f.directory, 0o700);
});

test('a leftover lock fails closed rather than guessing whether a writer is alive', t => {
  const f = vaultFixture(t); writeFileSync(f.path + '.lock', '', { mode: 0o600 });
  assert.throws(() => f.vault.compareAndSet('identity', undefined, {}), /RECOVERY_REQUIRED/);
  assert.equal(f.vault.read('identity'), undefined);
  unlinkSync(f.path + '.lock'); assert.equal(f.vault.compareAndSet('identity', undefined, {}), true);
});

test('bounds and accessor rejection leave the encrypted snapshot unchanged', t => {
  const f = vaultFixture(t); f.vault.compareAndSet('identity', undefined, {}); const previous = readFileSync(f.path);
  assert.throws(() => f.vault.compareAndSet('identity', 1, { big: 'x'.repeat(1_048_576) }), /SIZE_LIMIT/);
  let invoked = false; const value = {}; Object.defineProperty(value, 'secret', { enumerable: true, get() { invoked = true; return 1; } });
  assert.throws(() => f.vault.compareAndSet('identity', 1, value), /ACCESSOR/);
  assert.equal(invoked, false); assert.deepEqual(readFileSync(f.path), previous);
});

test('encrypted replay checkpoints preserve exact-sequence CAS across reopen', t => {
  const f = vaultFixture(t), store = new EncryptedCheckpointStore(f.vault);
  assert.equal(store.compareAndSet('scope', undefined, { epoch: 1, sequence: 1 }), true);
  assert.equal(store.compareAndSet('scope', undefined, { epoch: 1, sequence: 1 }), false);
  assert.throws(() => store.compareAndSet('scope', { epoch: 1, sequence: 1 }, { epoch: 1, sequence: 3 }), /REPLAY_OR_GAP/);
  const reopened = new EncryptedFileVault({ ...f.options, minimumRevision: f.vault.revision }); t.after(() => reopened.close());
  assert.deepEqual(new EncryptedCheckpointStore(reopened).read('scope'), { epoch: 1, sequence: 1 });
});

test('ratchet state and consumed-message protection survive a real encrypted-file reopen', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const first = await f.alice.channel.seal(f.bobId, 'manifest', { content: 'first' }, f.messageOptions('first'));
  await f.bob.channel.receive(first);
  const floor = f.bob.vault.revision;
  f.bob.channel.close(); f.bob.vault.close();
  f.bob.vault = new EncryptedFileVault({ ...f.bob.options, minimumRevision: floor });
  f.bob.channel = new SignalParentChannel({ vault: f.bob.vault, scope, localRegistry: f.bob.registry, nowUnixMs: () => f.now });
  f.authorize(f.bob, f.alice);
  await assert.rejects(f.bob.channel.receive(first), /AUTHENTICATION_OR_REPLAY/);
  const next = await f.alice.channel.seal(f.bobId, 'manifest', { content: 'second' }, f.messageOptions('second'));
  assert.equal((await f.bob.channel.receive(next)).payload.content, 'second');
});

test('two channel objects sharing one vault cannot publish ciphertext from the same state twice', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const other = new SignalParentChannel({ vault: f.alice.vault, scope, localRegistry: f.alice.registry, nowUnixMs: () => f.now });
  t.after(() => other.close());
  other.authorizePeer(f.bob.registry, 'phone', { send: ALL, receive: ALL, expiresAtMs: f.now + 300_000 });
  const results = await Promise.allSettled([f.alice.channel.seal(f.bobId, 'ack', {}, f.messageOptions('one')),
    other.seal(f.bobId, 'ack', {}, f.messageOptions('two'))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /STATE_CONFLICT/);
  assert.equal((await f.bob.channel.receive(results.find(r => r.status === 'fulfilled').value)).kind, 'ack');
});
