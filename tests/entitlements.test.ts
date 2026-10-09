import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EntitlementLedger, MemoryEntitlementStore } from '../src/index.js';
import { SqliteEntitlementStore } from '../src/node/index.js';
import type { AuthenticatedActor, EntitlementRequest, EntitlementStore } from '../src/index.js';
const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, identityId: 'issuer' };
const issuer: AuthenticatedActor = { ...scope, deviceId: 'device', permissions: ['entitlements:manage'], expiresAtMs: 10_000 };
const subject: AuthenticatedActor = { ...issuer, identityId: 'subject', permissions: ['assets:read'] };
const request: EntitlementRequest = { grantId: 'grant', subjectId: 'subject', resources: [{ resourceId: 'resource', uses: ['download', 'cache'] }], source: { kind: 'purchase', recordId: 'order' }, expiresAtMs: 1000, authorizationEvidenceRef: 'sha256:' + 'd'.repeat(64) };
function fixture(store: EntitlementStore = new MemoryEntitlementStore()) { return new EntitlementLedger(scope, store); }
test('generic grants deduplicate their source even under competing IDs and normalize declared sets', async () => {
  const store = new MemoryEntitlementStore(), left = fixture(store), right = fixture(store);
  const values = await Promise.all([Promise.resolve().then(() => left.grant(issuer, request, 100)), Promise.resolve().then(() => right.grant(issuer, { ...request, grantId: 'other', resources: [{ resourceId: 'resource', uses: ['cache', 'download'] }] }, 101))]);
  assert.equal(values[0]!.grantId, values[1]!.grantId); assert.equal(store.transact(scope, state => state.grants.size), 1);
  assert.deepEqual(left.access(subject, 'resource', 'download', 200), { allowed: true, grantIds: ['grant'] });
  assert.equal(left.access(subject, 'resource', 'stream', 200).allowed, false);
  values[0]!.resources[0]!.uses.length = 0; assert.equal(left.access(subject, 'resource', 'download', 200).allowed, true);
});
test('source or ID substitution, cross-scope actors and unauthorized issuers reject', () => {
  const ledger = fixture(); ledger.grant(issuer, request, 100);
  for (const change of [{ subjectId: 'other' }, { source: { kind: 'purchase' as const, recordId: 'other' } }, { expiresAtMs: null }, { authorizationEvidenceRef: 'sha256:' + 'e'.repeat(64) }]) assert.throws(() => ledger.grant(issuer, { ...request, ...change }, 200), /ENTITLEMENT_ID_CONFLICT/);
  assert.throws(() => ledger.grant(subject, request, 100)); assert.throws(() => ledger.grant({ ...issuer, tenantId: 'other' }, request, 100));
  assert.throws(() => ledger.access({ ...subject, application: 'scenesignal' }, 'resource', 'download', 200));
  assert.equal(ledger.access({ ...subject, identityId: 'other' }, 'resource', 'download', 200).allowed, false);
});
test('expiry and terminal revocation deny access without rearming on replay', () => {
  const ledger = fixture(); const granted = ledger.grant(issuer, request, 100);
  assert.equal(ledger.access(subject, 'resource', 'download', 99).allowed, false); assert.equal(ledger.access(subject, 'resource', 'download', 1000).allowed, false);
  const revoked = ledger.revoke(issuer, granted.grantId, 'revocation', 300); assert.equal(revoked.revision, 2);
  assert.deepEqual(ledger.grant(issuer, request, 1100), revoked); assert.deepEqual(ledger.revoke(issuer, 'grant', 'retry', 1200), revoked);
  assert.equal(ledger.access(subject, 'resource', 'download', 400).allowed, false);
  assert.throws(() => ledger.grant(issuer, { ...request, grantId: 'new', source: { kind: 'promotion', recordId: 'new' } }, 1100), /ALREADY_EXPIRED/);
});
test('permanent bookkeeping entitlements remain separate from bounded delivery authority', () => {
  const ledger = fixture(); ledger.grant(issuer, { ...request, expiresAtMs: null }, 100);
  assert.equal(ledger.access(subject, 'resource', 'download', 5000).allowed, true);
  assert.throws(() => ledger.access(subject, 'resource', 'download', 10_000), /ACCESS_DENIED/);
});
test('entitlement transactions reject private-field injection and roll back thrown callbacks', () => {
  const store = new MemoryEntitlementStore(), ledger = fixture(store); ledger.grant(issuer, request, 100);
  assert.throws(() => store.transact(scope, state => { Object.assign(state.grants.get('grant')!, { mediaKey: 'forbidden' }); }), /UNKNOWN_ENTITLEMENT_GRANT/);
  assert.throws(() => store.transact(scope, state => { state.grants.clear(); throw Error('rollback'); }));
  assert.equal(ledger.access(subject, 'resource', 'download', 200).allowed, true);
});
test('real SQLite grants, source deduplication and revocation survive reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dae-entitlements-')), path = join(dir, 'entitlements.sqlite'); let store = new SqliteEntitlementStore(path);
  try {
    let ledger = fixture(store); const original = ledger.grant(issuer, request, 100); store.close(); store = new SqliteEntitlementStore(path); ledger = fixture(store);
    assert.deepEqual(ledger.grant(issuer, { ...request, grantId: 'another' }, 200), original); assert.equal(ledger.access(subject, 'resource', 'download', 200).allowed, true);
    const revoked = ledger.revoke(issuer, 'grant', 'revocation', 300); store.close(); store = new SqliteEntitlementStore(path); ledger = fixture(store);
    assert.equal(ledger.access(subject, 'resource', 'download', 400).allowed, false); assert.deepEqual(ledger.grant(issuer, request, 500), revoked);
    assert.equal(fixture(store).access({ ...subject, identityId: 'different' }, 'resource', 'download', 500).allowed, false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
