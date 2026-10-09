import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { SqliteCommerceStore, SqliteAccountingStore } from '../src/node/index.js';
import { ReconciliationEngine } from '../src/index.js';
import type { AccountingEvent, AccountingEventVerifier, SplitAgreement } from '../src/index.js';
import { commerceFixture, scope, manager, buyer } from './helpers/commerce.js';
const request = { checkoutId: 'checkout', productId: 'complete', productRevision: 1, territory: 'US' }, raw = new Uint8Array([1]);
function directory() { return mkdtempSync(join(tmpdir(), 'dae-business-')); }
async function settled(store: SqliteCommerceStore) {
  const f = commerceFixture(store), order = await f.engine.createCheckout(buyer, request, 100);
  f.setEvent({ scope, eventId: 'settlement', providerId: 'provider', merchantAccountId: 'account', checkoutId: 'checkout', buyerId: 'buyer', productDigestHex: order.productDigestHex, providerPaymentId: 'payment', currency: order.currency, amountMinor: order.amountMinor, occurredAtMs: 200, status: 'settled' });
  await f.engine.settle(raw, 'signed', 300); return { f, order };
}
test('real SQLite purchase and split records survive close/reopen with scoped private files', async () => {
  const dir = directory(), path = join(dir, 'business.sqlite'); let commerce = new SqliteCommerceStore(path), accounting = new SqliteAccountingStore(path);
  try {
    const { order } = await settled(commerce); assert.equal(statSync(path).mode & 0o777, 0o600);
    const agreement: SplitAgreement = { id: 'agreement', revision: 1, shares: [{ payeeId: 'payee', basisPoints: 10000 }], authorizationEvidenceRef: 'sha256:' + 'c'.repeat(64) };
    const event: AccountingEvent = { scope, eventId: 'capture', providerId: 'provider', merchantAccountId: 'account', checkoutId: 'checkout', providerPaymentId: 'payment', currency: order.currency, occurredAtMs: 300, kind: 'capture', grossMinor: order.amountMinor, feeMinor: '10', agreementId: 'agreement', agreementRevision: 1 };
    const verifier: AccountingEventVerifier = { async verify() { return event; } };
    let book = new ReconciliationEngine(scope, 'provider', 'account', commerce, accounting, verifier);
    book.registerAgreement(manager, agreement, 300); await book.accept(raw, 'signed', 400); const transfer = await book.reserveTransfer(manager, 'checkout', 'transfer', 'payee', '100', 500);
    const expected = book.statement(manager, 'checkout', 600); commerce.close(); accounting.close(); commerce = new SqliteCommerceStore(path); accounting = new SqliteAccountingStore(path);
    assert.equal(commerceFixture(commerce).engine.readOrder(buyer, 'checkout', 600)?.status, 'settled');
    book = new ReconciliationEngine(scope, 'provider', 'account', commerce, accounting, verifier); assert.deepEqual(book.statement(manager, 'checkout', 600), expected);
    assert.deepEqual(await book.reserveTransfer(manager, 'checkout', 'transfer', 'payee', '100', 700), transfer);
    assert.equal(commerce.transact({ ...scope, tenantId: 'other' }, state => state.orders.size), 0);
  } finally { commerce.close(); accounting.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('transaction exceptions, noncloneable results and private-field injection roll back', async () => {
  const dir = directory(), store = new SqliteCommerceStore(join(dir, 'business.sqlite'));
  try {
    await settled(store); const original = store.transact(scope, state => state.orders.get('checkout')!.amountMinor);
    assert.throws(() => store.transact(scope, state => { state.orders.get('checkout')!.amountMinor = '1'; throw Error('rollback'); }));
    assert.equal(store.transact(scope, state => state.orders.get('checkout')!.amountMinor), original);
    assert.throws(() => store.transact(scope, state => { Object.assign(state.orders.get('checkout')!, { mediaKey: 'forbidden' }); }), /INVALID_BUSINESS_RECORD/);
    assert.throws(() => store.transact(scope, state => { state.orders.get('checkout')!.amountMinor = '1'; return () => 1; }));
    assert.throws(() => store.transact(scope, () => Promise.resolve(1)), /ASYNC_BUSINESS_TRANSACTION/);
    assert.equal(store.transact(scope, state => state.orders.get('checkout')!.amountMinor), original);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('two independent processes settle the same event without duplicate financial records', async () => {
  const dir = directory(), path = join(dir, 'business.sqlite'), store = new SqliteCommerceStore(path);
  try {
    const f = commerceFixture(store); await f.engine.createCheckout(buyer, request, 100);
    const helper = new URL('./helpers/commerce.js', import.meta.url).href, nodeEntry = new URL('../src/node/index.js', import.meta.url).href;
    const script = `import {SqliteCommerceStore} from ${JSON.stringify(nodeEntry)}; import {commerceFixture,buyer,scope} from ${JSON.stringify(helper)};
      const store = new SqliteCommerceStore(process.argv[1]); const f = commerceFixture(store); const order = f.engine.readOrder(buyer,'checkout',300);
      f.setEvent({scope,eventId:'same',providerId:'provider',merchantAccountId:'account',checkoutId:'checkout',buyerId:'buyer',productDigestHex:order.productDigestHex,providerPaymentId:'payment',currency:order.currency,amountMinor:order.amountMinor,occurredAtMs:200,status:'settled'});
      const result=await f.engine.settle(new Uint8Array([1]),'signed',300); if(result.status!=='settled') process.exitCode=1; store.close();`;
    const child = () => new Promise<void>((done, reject) => {
      const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script, resolve(path)], { stdio: ['ignore', 'pipe', 'pipe'] }); let errors = '';
      process.stderr.on('data', data => { errors += String(data); }); process.on('error', reject); process.on('exit', code => code === 0 ? done() : reject(Error(errors)));
    });
    await Promise.all([child(), child()]); assert.equal(store.transact(scope, state => state.events.size), 1); assert.equal(f.engine.readOrder(buyer, 'checkout', 300)?.status, 'settled');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('file-backed business stores require owner-private directories and reject symlinks', () => {
  assert.throws(() => new SqliteCommerceStore(join(tmpdir(), 'dae-shared-directory.sqlite')), /PRIVATE_DIRECTORY/);
  const dir = directory(), store = new SqliteCommerceStore(join(dir, 'business.sqlite')); store.close(); symlinkSync(join(dir, 'business.sqlite'), join(dir, 'link.sqlite'));
  try { assert.throws(() => new SqliteCommerceStore(join(dir, 'link.sqlite'))); assert.throws(() => store.transact(scope, state => state.orders.size), /CLOSED/); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
