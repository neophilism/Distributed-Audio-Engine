import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { CiphertextRelayClient } from '../src/client.mjs';
import { relayFixture, packet, publicBundle, ALICE, BOB, EVE, raw, listen, stop, tlsMaterial } from './helpers.mjs';

test('actual TLS publishes one-time public bundles, routes ciphertext, and acknowledges only the owner mailbox', async t => {
  const f = await relayFixture(t); const [alice, bob, eve] = f.clients;
  await bob.publishBundle(publicBundle()); assert.equal((await alice.takeBundle(BOB)).body.address, BOB);
  assert.equal(await alice.takeBundle(BOB), null);
  const saved = await alice.send(BOB, packet()); assert.equal(saved.status, 'stored');
  const rows = await bob.poll(); assert.equal(rows[0].receiptId, saved.receiptId);
  assert.equal((await eve.poll()).length, 0); await eve.acknowledge([saved.receiptId]); assert.equal((await bob.poll()).length, 1);
  await bob.acknowledge([saved.receiptId]); assert.equal((await alice.send(BOB, packet())).status, 'acknowledged');
  assert.equal((await bob.poll()).length, 0);
});
test('missing, malformed and revoked routing tokens fail without affecting endpoint authority', async t => {
  const f = await relayFixture(t);
  assert.equal((await raw(f.origin)).status, 401);
  assert.equal((await raw(f.origin, { token: 'malformed' })).status, 401);
  f.access.revoke(f.grants[0].tokenSha256);
  await assert.rejects(f.clients[0].poll(), /HTTP_401/);
  assert.equal(f.store.stats(f.now).packets, 0);
});
test('an authenticated but unauthorized sender cannot route, take keys, or spoof another sender', async t => {
  const f = await relayFixture(t);
  await assert.rejects(f.clients[2].send(BOB, packet(EVE, BOB)), /HTTP_403/);
  await assert.rejects(f.clients[2].takeBundle(BOB), /HTTP_403/);
  await assert.rejects(f.clients[0].send(BOB, packet(EVE, BOB)), /HTTP_400/);
  await assert.rejects(f.clients[0].publishBundle(publicBundle(BOB)), /HTTP_400/);
});
test('browser-origin requests, query tokens, unsupported paths and content encodings fail closed', async t => {
  const f = await relayFixture(t); const token = f.tokens[0];
  assert.equal((await raw(f.origin, { token, headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await raw(f.origin, { token, path: '/v1/mailbox?token=value' })).status, 400);
  assert.equal((await raw(f.origin, { token, path: '/other' })).status, 404);
  const payload = JSON.stringify(packet());
  assert.equal((await raw(f.origin, { token, path: `/v1/mailboxes/${BOB}/messages`, method: 'PUT', payload,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Content-Encoding': 'gzip' } })).status, 400);
});
test('operator authorization changes during body delivery cannot commit under an old grant', async t => {
  const f = await relayFixture(t); const payload = JSON.stringify(packet());
  const pending = raw(f.origin, { token: f.tokens[0], method: 'PUT', path: `/v1/mailboxes/${BOB}/messages`, payload,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, delay: 100 });
  setTimeout(() => f.access.revoke(f.grants[0].tokenSha256), 30);
  assert.equal((await pending).status, 401); assert.equal(f.store.stats(f.now).packets, 0);
});
test('duplicate and oversized request bodies are rejected before persistent storage', async t => {
  const f = await relayFixture(t); const token = f.tokens[0];
  const payload = '{"deliveryId":"a","deliveryId":"b"}';
  assert.equal((await raw(f.origin, { token, method: 'PUT', path: `/v1/mailboxes/${BOB}/messages`, payload,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } })).status, 400);
  assert.equal((await raw(f.origin, { token, method: 'PUT', path: `/v1/mailboxes/${BOB}/messages`,
    headers: { 'Content-Type': 'application/json', 'Content-Length': 1000000 }, payload: '{}' })).status, 413);
  assert.equal(f.store.stats(f.now).packets, 0);
});
test('TLS verification is mandatory; wrong CA, invalid origin and plaintext URLs cannot become fallback transport', async t => {
  const f = await relayFixture(t);
  const untrusted = new CiphertextRelayClient({ origin: f.origin, token: f.tokens[0] }); t.after(() => untrusted.close());
  await assert.rejects(untrusted.poll(), /TRANSPORT_FAILED/);
  for (const origin of ['http://localhost', 'https://a:b@localhost', 'https://localhost/path', 'https://localhost?key=x']) {
    assert.throws(() => new CiphertextRelayClient({ origin, token: f.tokens[0] }), /HTTPS_ORIGIN/);
  }
});
test('response redirects, oversized lengths, compression and truncated JSON are never followed or accepted', async t => {
  const tls = tlsMaterial(); let mode = 'redirect';
  const server = createServer(tls, (_req, res) => {
    if (mode === 'redirect') { res.writeHead(302, { Location: 'https://untrusted.example' }); res.end(); }
    if (mode === 'large') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 9999999 }); res.end('{}'); }
    if (mode === 'gzip') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 2, 'Content-Encoding': 'gzip' }); res.end('{}'); }
    if (mode === 'truncated') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 20 }); res.end('{}'); }
  });
  const origin = await listen(server); t.after(() => stop(server));
  const client = new CiphertextRelayClient({ origin, token: 'a'.repeat(42) + 'A', ca: tls.cert, timeoutMs: 150 }); t.after(() => client.close());
  for (const next of ['redirect', 'large', 'gzip', 'truncated']) { mode = next; await assert.rejects(client.poll()); }
});
test('deadline, cancellation and client closure destroy outstanding connections rather than leaving background requests', async t => {
  const tls = tlsMaterial(); const server = createServer(tls, () => {}); const origin = await listen(server); t.after(() => stop(server));
  const options = { origin, token: 'a'.repeat(42) + 'A', ca: tls.cert, timeoutMs: 100 };
  const client = new CiphertextRelayClient(options); t.after(() => client.close());
  await assert.rejects(client.poll(), /TIMEOUT/);
  const abort = new AbortController(); const pending = client.poll(abort.signal); abort.abort(); await assert.rejects(pending, /ABORTED/);
  const closing = client.poll(); client.close(); await assert.rejects(closing, /CLOSED/); await assert.rejects(client.poll(), /CLOSED/);
});
test('expiry sweeper purges idle mailboxes without waiting for a recipient request', async t => {
  const f = await relayFixture(t); await f.clients[0].send(BOB, packet()); f.setNow(2000);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(f.store.stats(2000).packets, 0); assert.equal((await raw(f.origin, { path: '/healthz' })).status, 200);
});

test('real TLS chunk delivery feeds the scoped transport without a private manifest at the relay', async t => {
  const f = await relayFixture(t); const scope = { tenantId: 'tenant', application: 'distributed-radio' };
  const chunk = { ...scope, storageObjectId: 'opaque', chunkIndex: 0, readers: [BOB], expiresAtMs: 2000,
    ciphertextBase64: Buffer.alloc(65552, 37).toString('base64') };
  await f.clients[0].uploadChunk(chunk);
  const request = { ...scope, storageObjectId: 'opaque', chunkIndex: 0, expectedBytes: 65552 };
  assert.deepEqual(await f.clients[1].chunksFrom(ALICE, scope).read(request), Buffer.alloc(65552, 37));
  await assert.rejects(f.clients[2].chunksFrom(ALICE, scope).read(request), /HTTP_403/);
  await assert.rejects(f.clients[1].chunksFrom(ALICE, scope).read({ ...request, expectedBytes: 20 }), /HTTP_400/);
  await assert.rejects(f.clients[1].chunksFrom(ALICE, scope).read({ ...request, tenantId: 'different' }), /SCOPE_OR_SIZE/);
  await assert.rejects(f.clients[0].uploadChunk({ ...chunk, readers: [EVE] }), /HTTP_403/);
});

test('grant snapshots are immutable and request budgets are bounded by configured credentials', async t => {
  const f = await relayFixture(t); const grant = f.access.authenticate('Bearer ' + f.tokens[0], f.now);
  assert.throws(() => grant.allowedRecipients.push(EVE));
  for (let i = 0; i < 256; i++) f.access.admit(grant, f.now);
  assert.throws(() => f.access.admit(grant, f.now), error => error.status === 429);
  await assert.rejects(f.clients[0].poll(), /HTTP_429/);
  f.setNow(11000); assert.equal((await f.clients[0].poll()).length, 0);
});
test('clock rollback latches unhealthy instead of reviving expired routing grants', async t => {
  const f = await relayFixture(t); await f.clients[0].poll(); f.setNow(999);
  assert.equal((await raw(f.origin, { path: '/healthz' })).status, 503);
  f.setNow(1001); await assert.rejects(f.clients[0].poll(), /HTTP_503/);
});
test('a stalled request body is terminated within the server deadline without storing a partial record', async t => {
  const f = await relayFixture(t, { deadline: 150 });
  const payload = JSON.stringify(packet());
  await assert.rejects(raw(f.origin, { token: f.tokens[0], method: 'PUT', path: `/v1/mailboxes/${BOB}/messages`, payload,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, delay: 400 }));
  assert.equal(f.store.stats(f.now).packets, 0);
});
