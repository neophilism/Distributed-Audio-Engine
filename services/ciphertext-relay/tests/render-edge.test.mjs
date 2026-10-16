import test from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SqliteCiphertextMailbox, RelayAccessPolicy, createCiphertextRelay,
  createRenderEdgeCiphertextRelay, CiphertextRelayClient } from '../src/index.mjs';
import { runRenderRelay } from '../src/render-main.mjs';
import { hash } from '../src/records.mjs';
import { ALICE, BOB, packet, publicBundle, tlsMaterial, listen, stop } from './helpers.mjs';

const publicOrigin = 'https://dae-isolated-staging.onrender.com', sourceCommit = 'c'.repeat(40);
const host = new URL(publicOrigin).host;
async function edgeFixture(t) {
  let now = 1000;
  const tokens = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
  const grants = [ALICE, BOB].map((address, i) => ({ address, tokenSha256: hash(tokens[i]),
    expiresAtMs: 5000, allowedRecipients: [[BOB], [ALICE]][i] }));
  const store = new SqliteCiphertextMailbox(':memory:'), access = new RelayAccessPolicy(grants);
  const server = createRenderEdgeCiphertextRelay({ store, access, publicOrigin, sourceCommit, nowUnixMs: () => now });
  await listen(server); const port = server.address().port;
  t.after(async () => { await stop(server); store.close(); });
  return { server, store, access, tokens, grants, port, setNow(n) { now = n; } };
}
function raw(port, { method = 'GET', path = '/v1/mailbox', headers = {}, token, payload } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, method, path, agent: false,
      headers: { Host: host, 'X-Forwarded-Proto': 'https', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } }, res => {
      const parts = []; res.on('data', chunk => parts.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(parts).toString() }));
    }); req.on('error', reject); req.end(payload);
  });
}
async function freePort() { const server = createServer(); await listen(server); const port = server.address().port; await stop(server); return port; }

test('Render: explicit service admission preserves token authentication and mailbox isolation', async t => {
  const f = await edgeFixture(t);
  assert.equal((await raw(f.port)).status, 401);
  assert.equal((await raw(f.port, { token: f.tokens[0] })).text, '{"messages":[]}');
  const payload = JSON.stringify(packet());
  const sent = await raw(f.port, { token: f.tokens[0], method: 'PUT', path: `/v1/mailboxes/${BOB}/messages`,
    payload, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } });
  assert.equal(sent.status, 200);
  assert.equal(JSON.parse((await raw(f.port, { token: f.tokens[1] })).text).messages.length, 1);
  assert.equal(JSON.parse((await raw(f.port, { token: f.tokens[0] })).text).messages.length, 0);
});
test('Render: forwarded scheme and exact deployed host are mandatory for every authenticated operation', async t => {
  const f = await edgeFixture(t);
  for (const headers of [{ 'X-Forwarded-Proto': '' }, { 'X-Forwarded-Proto': 'http' },
    { 'X-Forwarded-Proto': 'https,http' }, { 'X-Forwarded-Proto': ['https', 'https'] },
    { Host: 'evil.example' }, { Host: host + '.evil.example' }, { Host: host + ':443' }])
    assert.equal((await raw(f.port, { token: f.tokens[0], headers })).status, 403);
  assert.equal(f.store.stats(1000).packets, 0);
});
test('Render: probes report actual store access, source binding and temporary test storage, not product completion', async t => {
  const f = await edgeFixture(t);
  const probe = await raw(f.port, { path: '/healthz', headers: { Host: 'internal-probe', 'X-Forwarded-Proto': '' } });
  assert.equal(probe.status, 200);
  assert.deepEqual(JSON.parse(probe.text), { status: 'ready', protocol: 1, environment: 'staging',
    transport: 'render-managed-tls-edge', storage: 'ephemeral-sqlite', sourceCommit, routingConfigured: true, productionReady: false });
  assert.equal(probe.headers['cache-control'], 'no-store');
  f.setNow(6000); assert.equal(JSON.parse((await raw(f.port, { path: '/healthz' })).text).routingConfigured, false);
  assert.equal((await raw(f.port, { token: f.tokens[0] })).status, 401);
});
test('Render: origin/cookie/query/body restrictions are identical to standalone TLS service', async t => {
  const f = await edgeFixture(t);
  for (const headers of [{ Origin: publicOrigin }, { Cookie: 'session=secret' }])
    assert.equal((await raw(f.port, { token: f.tokens[0], headers })).status, 403);
  assert.equal((await raw(f.port, { token: f.tokens[0], path: '/v1/mailbox?token=secret' })).status, 400);
  assert.equal((await raw(f.port, { token: f.tokens[0], path: '/v1/chunks', method: 'PUT', payload: '{}',
    headers: { 'Content-Type': 'application/json', 'Content-Length': 2, 'Content-Encoding': 'gzip' } })).status, 400);
});
test('Render: raw endpoint keys and private manifests cannot become routing configuration', async () => {
  const store = new SqliteCiphertextMailbox(':memory:');
  try {
    for (const grant of [{ token: 'secret' }, { tokenSha256: hash('not-a-key'), address: ALICE,
      allowedRecipients: [BOB], expiresAtMs: 10000, privateManifest: { key: 'never' } }])
      assert.throws(() => new RelayAccessPolicy([grant]));
    for (const origin of ['http://dae.onrender.com', 'https://evil.example', publicOrigin + '/',
      publicOrigin + '?key=value', 'https://user:secret@dae.onrender.com'])
      assert.throws(() => createRenderEdgeCiphertextRelay({ store, access: new RelayAccessPolicy([]),
        publicOrigin: origin, sourceCommit }), /RENDER_ORIGIN/);
    assert.throws(() => createRenderEdgeCiphertextRelay({ store, access: new RelayAccessPolicy([]),
      publicOrigin, sourceCommit: 'not-a-commit' }), /SOURCE_COMMIT/);
    assert.throws(() => createCiphertextRelay({ store, access: new RelayAccessPolicy([]), publicOrigin }), /TLS_REQUIRED/);
  } finally { store.close(); }
});
test('Render: actual verified TLS client interoperates across a managed-edge-style HTTP hop', async t => {
  const f = await edgeFixture(t), tls = tlsMaterial();
  const proxy = createTlsServer({ ...tls, minVersion: 'TLSv1.3' }, (req, res) => {
    const upstream = request({ hostname: '127.0.0.1', port: f.port, path: req.url, method: req.method,
      headers: { ...req.headers, host, 'x-forwarded-proto': 'https' }, agent: false }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    }); upstream.on('error', () => res.destroy()); req.pipe(upstream);
  });
  const origin = await listen(proxy); t.after(() => stop(proxy));
  const clients = f.tokens.map(token => new CiphertextRelayClient({ origin, token, ca: tls.cert }));
  t.after(() => clients.forEach(client => client.close()));
  await clients[1].publishBundle(publicBundle());
  assert.equal((await clients[0].takeBundle(BOB)).body.address, BOB); assert.equal(await clients[0].takeBundle(BOB), null);
  const sent = await clients[0].send(BOB, packet());
  assert.equal((await clients[1].poll())[0].receiptId, sent.receiptId);
  await clients[1].acknowledge([sent.receiptId]); assert.equal((await clients[0].send(BOB, packet())).status, 'acknowledged');
});
test('Render: clock rollback latches readiness failure instead of accepting renewed requests', async t => {
  const f = await edgeFixture(t); await raw(f.port, { token: f.tokens[0] }); f.setNow(999);
  assert.equal((await raw(f.port, { path: '/healthz' })).status, 503); f.setNow(2000);
  assert.equal((await raw(f.port, { token: f.tokens[0] })).status, 503);
});
test('Render: launcher refuses implicit production, other repositories and malformed operator configuration', async () => {
  const env = { RENDER: 'true', RENDER_SERVICE_TYPE: 'web', DAE_RELAY_MODE: 'render-staging',
    RENDER_GIT_REPO_SLUG: 'neophilism/Distributed-Audio-Engine', RENDER_EXTERNAL_URL: publicOrigin,
    RENDER_GIT_COMMIT: sourceCommit, PORT: '12345', DAE_RELAY_GRANTS_JSON: '[]' };
  for (const patch of [{ RENDER: '' }, { RENDER_SERVICE_TYPE: 'worker' }, { DAE_RELAY_MODE: 'production' },
    { RENDER_GIT_REPO_SLUG: 'other/repo' }, { PORT: '0' }, { PORT: '443' }, { PORT: '65536' },
    { PORT: '18012' }, { DAE_RELAY_GRANTS_JSON: '{"secret":"bad"}' }, { DAE_RELAY_GRANTS_JSON: '[' },
    { RENDER_EXTERNAL_URL: 'https://evil.example' }, { RENDER_GIT_COMMIT: '' }])
    await assert.rejects(runRenderRelay({ ...env, ...patch }));
});
test('Render: launcher boots real SQLite with no default client credential and closes idempotently', async t => {
  const port = await freePort();
  const runtime = await runRenderRelay({ RENDER: 'true', RENDER_SERVICE_TYPE: 'web', DAE_RELAY_MODE: 'render-staging',
    RENDER_GIT_REPO_SLUG: 'neophilism/Distributed-Audio-Engine', RENDER_EXTERNAL_URL: publicOrigin,
    RENDER_GIT_COMMIT: sourceCommit, PORT: String(port) }); t.after(() => runtime.close());
  assert.equal((await raw(port)).status, 401);
  const probe = await raw(port, { path: '/healthz' }); assert.equal(probe.status, 200);
  assert.equal(JSON.parse(probe.text).routingConfigured, false);
  await runtime.close(); await runtime.close();
});
test('Render: rejected CLI startup never prints environment secrets or exception payloads', () => {
  const canary = 'PRIVATE-CANARY-DO-NOT-LOG';
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../src/render-main.mjs', import.meta.url))],
    { env: { ...process.env, RENDER: 'false', DAE_RELAY_GRANTS_JSON: canary }, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 1); assert.equal(child.stdout.includes(canary), false); assert.equal(child.stderr.includes(canary), false);
  assert.match(child.stderr, /Ciphertext relay startup rejected/);
});

test('Render: a failed real datastore probe latches unhealthy rather than serving a fake ready response', async t => {
  const f = await edgeFixture(t); f.store.close();
  assert.equal((await raw(f.port, { path: '/healthz' })).status, 503);
  assert.equal((await raw(f.port, { token: f.tokens[0] })).status, 503);
});
