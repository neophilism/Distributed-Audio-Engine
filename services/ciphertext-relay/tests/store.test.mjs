import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync, chmodSync, linkSync, unlinkSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../src/records.mjs';
import { SqliteCiphertextMailbox } from '../src/store.mjs';
import { packet, publicBundle, ALICE, BOB, EVE } from './helpers.mjs';
function fixture(t, limits) {
  const directory = mkdtempSync(join(tmpdir(), 'dae-mailbox-')), path = join(directory, 'relay.sqlite');
  const store = new SqliteCiphertextMailbox(path, limits);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); }); return { store, path, directory };
}
test('ciphertext survives reopening; delivery retries and acknowledged tombstones are idempotent', t => {
  const f = fixture(t); const original = packet(); const saved = f.store.enqueue(ALICE, BOB, original, 1000);
  assert.equal(saved.status, 'stored'); assert.deepEqual(f.store.enqueue(ALICE, BOB, original, 1001), saved);
  f.store.close(); const reopened = new SqliteCiphertextMailbox(f.path); t.after(() => reopened.close());
  assert.equal(reopened.poll(BOB, 1002)[0].packet.record.ciphertext, 'AQID');
  reopened.acknowledge(BOB, [saved.receiptId], 1002);
  assert.deepEqual(reopened.poll(BOB, 1002), []);
  assert.equal(reopened.enqueue(ALICE, BOB, original, 1003).status, 'acknowledged');
  assert.equal(reopened.stats(1003).bytes, 0);
});
test('mailboxes isolate readers and acknowledgments; changed delivery IDs cannot overwrite records', t => {
  const { store } = fixture(t); const original = packet(); const saved = store.enqueue(ALICE, BOB, original, 1000);
  assert.deepEqual(store.poll(EVE, 1000), []); store.acknowledge(EVE, [saved.receiptId], 1000);
  assert.equal(store.poll(BOB, 1000).length, 1);
  assert.throws(() => store.enqueue(ALICE, BOB, { ...original, record: { ...original.record, ciphertext: 'BAUG' } }, 1001), /CONFLICT/);
  assert.equal(store.poll(BOB, 1001)[0].packet.record.ciphertext, 'AQID');
});
test('public one-time bundles are taken once and cannot be republished from a tombstone', t => {
  const f = fixture(t), bundle = publicBundle(); const saved = f.store.publish(BOB, bundle, 1000);
  assert.equal(saved.status, 'available');
  const other = new SqliteCiphertextMailbox(f.path); t.after(() => other.close());
  assert.equal(canonicalJson(other.take(BOB, 1001)), canonicalJson(bundle)); assert.equal(f.store.take(BOB, 1001), null);
  assert.equal(f.store.publish(BOB, bundle, 1002).status, 'taken'); assert.equal(f.store.take(BOB, 1002), null);
  assert.throws(() => f.store.publish(ALICE, bundle, 1002), /BINDING/);
});
test('expiry deletes packet bodies and public-key records, and observed clock rollback rejects', t => {
  const f = fixture(t); f.store.enqueue(ALICE, BOB, packet(), 1000); f.store.publish(BOB, publicBundle(), 1000);
  f.store.sweep(2000); assert.deepEqual(f.store.stats(2000), { packets: 0, pending: 0, bytes: 0, bundles: 0, availableBundles: 0, chunks: 0, chunkBytes: 0 });
  assert.throws(() => f.store.poll(BOB, 1999)); f.store.close();
  const next = new SqliteCiphertextMailbox(f.path); t.after(() => next.close()); assert.throws(() => next.poll(BOB, 1999));
});
test('quota rejection never evicts an existing message; poll and acknowledge batches are bounded', t => {
  const { store } = fixture(t, { maxMailboxPackets: 1 });
  store.enqueue(ALICE, BOB, packet(), 1000);
  assert.throws(() => store.enqueue(ALICE, BOB, packet(ALICE, BOB, 'second'), 1000), /QUOTA/);
  assert.equal(store.poll(BOB, 1000)[0].packet.deliveryId, 'delivery');
  assert.throws(() => store.acknowledge(BOB, Array(9).fill(ALICE), 1000), /ACK_LIMIT/);
});
test('private manifests, keys, unknown fields and wrong inner routes are not relay API records', t => {
  const { store } = fixture(t);
  for (const alter of [p => p.recordType = 'manifest', p => p.record = { attachmentKeyHex: 'secret' },
    p => p.record.to = EVE, p => p.record.privateKey = 'secret', p => p.expiresAtMs = 900000,
    p => p.record.ciphertext = '', p => p.record.ciphertext = '!!!']) {
    const changed = packet(); alter(changed); assert.throws(() => store.enqueue(ALICE, BOB, changed, 1000));
  }
  assert.equal(store.stats(1000).packets, 0);
});
test('the database contains only ciphertext/public metadata columns and requires private file ownership', t => {
  const f = fixture(t); f.store.enqueue(ALICE, BOB, packet(), 1000);
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
  f.store.close(); const db = new DatabaseSync(f.path, { readOnly: true });
  try { assert.equal(db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get('relay_packets').sql.includes('private_key'), false); }
  finally { db.close(); }
  chmodSync(f.path, 0o644); assert.throws(() => new SqliteCiphertextMailbox(f.path), /PRIVATE_FILE/); chmodSync(f.path, 0o600);
  const linked = join(f.directory, 'linked'); linkSync(f.path, linked); assert.throws(() => new SqliteCiphertextMailbox(f.path), /PRIVATE_FILE/); unlinkSync(linked);
  const symlink = join(f.directory, 'symlink'); symlinkSync(f.path, symlink); assert.throws(() => new SqliteCiphertextMailbox(symlink));
  assert.ok(readFileSync(f.path).length > 0);
});
test('an unrelated SQLite file is rejected rather than migrated or overwritten', t => {
  const f = fixture(t); f.store.close();
  const unrelatedPath = join(f.directory, 'unrelated'); const db = new DatabaseSync(unrelatedPath);
  db.exec('CREATE TABLE customer_data (id INTEGER)'); db.close(); chmodSync(unrelatedPath, 0o600);
  assert.throws(() => new SqliteCiphertextMailbox(unrelatedPath), /UNRELATED_DATABASE/);
});

test('opaque audio chunks are scoped, immutable, recipient-restricted, bounded and expiring', t => {
  const f = fixture(t, { maxChunks: 1, maxChunkBytes: 100 });
  const chunk = { application: 'distributed-radio', tenantId: 'tenant', storageObjectId: 'object', chunkIndex: 0,
    ciphertextBase64: Buffer.alloc(20, 17).toString('base64'), readers: [BOB], expiresAtMs: 2000 };
  const request = { application: chunk.application, tenantId: chunk.tenantId, storageObjectId: chunk.storageObjectId, chunkIndex: 0, expectedBytes: 20 };
  const saved = f.store.putChunk(ALICE, chunk, 1000); assert.deepEqual(f.store.putChunk(ALICE, chunk, 1000), saved);
  assert.deepEqual(f.store.readChunk(BOB, ALICE, request, 1000), Uint8Array.from(Buffer.alloc(20, 17)));
  assert.throws(() => f.store.readChunk(EVE, ALICE, request, 1000), /UNAVAILABLE/);
  assert.throws(() => f.store.readChunk(BOB, EVE, request, 1000), /UNAVAILABLE/);
  assert.throws(() => f.store.readChunk(BOB, ALICE, { ...request, tenantId: 'other' }, 1000), /UNAVAILABLE/);
  assert.throws(() => f.store.putChunk(ALICE, { ...chunk, readers: [EVE] }, 1000), /CONFLICT/);
  assert.throws(() => f.store.putChunk(ALICE, { ...chunk, chunkIndex: 1 }, 1000), /QUOTA/);
  assert.throws(() => f.store.putChunk(ALICE, { ...chunk, attachmentKeyHex: 'secret' }, 1000), /INVALID_RECORD/);
  f.store.sweep(2000); assert.equal(f.store.stats(2000).chunkBytes, 0);
  assert.throws(() => f.store.readChunk(BOB, ALICE, request, 2000), /UNAVAILABLE/);
});
