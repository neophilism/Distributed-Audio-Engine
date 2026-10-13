import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManifestHeads } from '../src/manifest-heads.mjs';
import { snapshot } from '../src/validation.mjs';
function vault() {
  return { row: undefined, fail: false,
    read() { return this.row && snapshot(this.row); },
    compareAndSet(_name, expected, value) {
      if (this.fail || expected !== this.row?.revision) return false;
      this.row = { revision: (expected ?? 0) + 1, value: snapshot(value) }; return true;
    } };
}
const message = (issuedAtMs, assetId = 'asset', extra = '') => ({ issuedAtMs, expiresAtMs: issuedAtMs + 300000,
  payload: { assetId, attachmentKeyHex: 'private-key-' + extra } });

test('manifest heads reject older and same-time substituted manifests without retaining private payloads', () => {
  const store = vault(), heads = new ManifestHeads(store, { endpoint: 'owned' });
  heads.remember(message(100), 100); heads.remember(message(101), 101);
  const before = snapshot(store.row);
  assert.throws(() => heads.remember(message(100), 102), /ROLLBACK/);
  assert.throws(() => heads.remember(message(101, 'asset', 'changed'), 102), /ROLLBACK/);
  assert.deepEqual(snapshot(store.row), before); heads.remember(message(101), 102);
  assert.equal(JSON.stringify(store.row).includes('private-key'), false);
});

test('manifest heads fail closed on persisted corruption, binding substitution and clock rollback', () => {
  for (const modify of [store => { store.row.value = null; }, store => { store.row.value.binding = '0'.repeat(64); },
    store => { store.row.value.heads.push({ ...store.row.value.heads[0] }); }]) {
    const store = vault(), heads = new ManifestHeads(store, { endpoint: 'owned' }); heads.remember(message(100), 100);
    modify(store); assert.throws(() => heads.remember(message(101), 101));
  }
  const store = vault(), heads = new ManifestHeads(store, { endpoint: 'owned' }); heads.remember(message(100), 101);
  assert.throws(() => heads.remember(message(100), 100));
});

test('manifest head persistence failures cannot replace the last committed version', () => {
  const store = vault(), heads = new ManifestHeads(store, { endpoint: 'owned' }); heads.remember(message(100), 100);
  const before = snapshot(store.row); store.fail = true;
  assert.throws(() => heads.remember(message(101), 101), /CONFLICT/); assert.deepEqual(snapshot(store.row), before);
});

test('manifest head capacity rejects growth instead of discarding live anti-rollback state', () => {
  const store = vault(), heads = new ManifestHeads(store, { endpoint: 'owned' });
  for (let i = 0; i < 64; i++) heads.remember(message(100, 'asset-' + i), 100);
  const before = snapshot(store.row); assert.throws(() => heads.remember(message(101, 'overflow'), 101), /LIMIT/);
  assert.deepEqual(snapshot(store.row), before);
  heads.remember(message(300100, 'new'), 300100); assert.equal(store.row.value.heads.length, 1);
});
