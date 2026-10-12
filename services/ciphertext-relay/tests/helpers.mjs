import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request } from 'node:https';
import { SqliteCiphertextMailbox, RelayAccessPolicy, createCiphertextRelay, CiphertextRelayClient } from '../src/index.mjs';
import { hash } from '../src/records.mjs';
let material;
export function tlsMaterial() {
  if (material) return material;
  const directory = mkdtempSync(join(tmpdir(), 'dae-relay-tls-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
    material = { key: readFileSync(join(directory, 'key.pem')), cert: readFileSync(join(directory, 'cert.pem')) };
    return material;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
export const ALICE = 'a'.repeat(64), BOB = 'b'.repeat(64), EVE = 'e'.repeat(64);
export const packet = (from = ALICE, to = BOB, id = 'delivery', expiresAtMs = 2000) => ({
  deliveryId: id, recordType: 'signal', expiresAtMs,
  record: { protocol: 'signal-libsignal-0.105.0', from, to, messageType: 3, ciphertext: 'AQID' }
});
export const publicBundle = (owner = BOB, id = 1, expiresAtMs = 2000) => ({
  body: { protocol: 'signal-libsignal-0.105.0', scope: { tenantId: 'tenant', application: 'distributed-radio', sessionId: 'session' },
    address: owner, issuedAtMs: 1000, expiresAtMs, registrationId: 17, deviceId: 1,
    identityKey: Buffer.alloc(33, 5).toString('base64'), preKeyId: id, preKey: Buffer.alloc(33, 5).toString('base64'),
    signedPreKeyId: 1, signedPreKey: Buffer.alloc(33, 5).toString('base64'), signedPreKeySignature: Buffer.alloc(64).toString('base64'),
    kyberPreKeyId: id, kyberPreKey: Buffer.alloc(1568).toString('base64'), kyberPreKeySignature: Buffer.alloc(64).toString('base64') },
  signature: Buffer.alloc(64).toString('base64')
});
export async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return 'https://127.0.0.1:' + server.address().port;
}
export async function stop(server) {
  const promise = new Promise(resolve => server.close(resolve));
  server.closeAllConnections(); await promise;
}
export async function relayFixture(t, { addresses = [ALICE, BOB, EVE], clock, limits, deadline = 1000 } = {}) {
  let now = 1000; const getNow = clock ?? (() => now);
  const tokens = addresses.map(() => randomBytes(32).toString('base64url'));
  const grants = addresses.map((address, i) => ({ address, tokenSha256: hash(tokens[i]), expiresAtMs: getNow() + 300000,
    allowedRecipients: i === 2 ? [] : [addresses[1 - i]] }));
  const access = new RelayAccessPolicy(grants), store = new SqliteCiphertextMailbox(':memory:', limits);
  const tls = tlsMaterial();
  const server = createCiphertextRelay({ store, access, ...tls, nowUnixMs: getNow, requestDeadlineMs: deadline });
  const origin = await listen(server);
  const clients = tokens.map(token => new CiphertextRelayClient({ origin, token, ca: tls.cert, timeoutMs: 1500 }));
  t.after(async () => { clients.forEach(c => c.close()); await stop(server); store.close(); });
  return { store, server, clients, tokens, grants, access, origin, tls, get now() { return getNow(); }, setNow(value) { now = value; } };
}
export function raw(origin, { method = 'GET', path = '/v1/mailbox', token, headers = {}, payload, ca = tlsMaterial().cert, delay = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(origin + path, { method, ca, agent: false, minVersion: 'TLSv1.3', headers: {
      ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers } }, res => {
      const data = []; res.on('data', chunk => data.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(data).toString(), headers: res.headers }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (delay) { req.flushHeaders(); setTimeout(() => req.end(payload), delay); }
    else req.end(payload);
  });
}
