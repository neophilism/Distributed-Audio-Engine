import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { SqliteCiphertextMailbox } from './store.mjs';
import { address, clone, decode, encode, exact, hash, integer, invariant, MAX_BODY_BYTES, MAX_RESPONSE_BYTES, MAX_CHUNK_BODY_BYTES } from './records.mjs';

class RequestFailure extends Error {
  constructor(status) { super('RELAY_REQUEST_REJECTED'); this.status = status; }
}
const reject = (condition, status = 400) => { if (!condition) throw new RequestFailure(status); };

/** Private operator configuration for routing access only, never E2EE membership.
 * A stolen routing credential still cannot substitute a peer's enrolled keys.
 * Supply hashes of independent, random 32-byte tokens; never reuse endpoint keys.
 */
export class RelayAccessPolicy {
  #grants = new Map(); #budgets = new Map();
  constructor(grants) {
    invariant(Array.isArray(grants) && grants.length <= 64, 'RELAY_GRANT_LIMIT');
    for (const grant of grants) this.set(grant);
  }
  set(value) {
    const grant = clone(value);
    exact(grant, ['tokenSha256', 'address', 'expiresAtMs', 'allowedRecipients']);
    address(grant.tokenSha256); address(grant.address); integer(grant.expiresAtMs, 1);
    invariant(Array.isArray(grant.allowedRecipients) && grant.allowedRecipients.length <= 32 &&
      new Set(grant.allowedRecipients).size === grant.allowedRecipients.length, 'RELAY_GRANT_RECIPIENT_LIMIT');
    grant.allowedRecipients.forEach(address);
    invariant(this.#grants.has(grant.tokenSha256) || this.#grants.size < 64, 'RELAY_GRANT_LIMIT');
    Object.freeze(grant.allowedRecipients);
    this.#grants.set(grant.tokenSha256, Object.freeze(grant));
  }
  activeCount(now) { integer(now); return [...this.#grants.values()].filter(grant => grant.expiresAtMs > now).length; }
  revoke(tokenSha256) { address(tokenSha256); this.#grants.delete(tokenSha256); this.#budgets.delete(tokenSha256); }
  authenticate(header, now) {
    reject(typeof header === 'string' && /^Bearer [A-Za-z0-9_-]{43}$/.test(header), 401);
    const token = header.slice(7);
    reject(Buffer.from(token, 'base64url').length === 32 && Buffer.from(token, 'base64url').toString('base64url') === token, 401);
    const wanted = Buffer.from(hash(token), 'hex');
    let found;
    // Bounded scan avoids a secret-dependent map lookup timing shortcut.
    for (const grant of this.#grants.values()) if (timingSafeEqual(wanted, Buffer.from(grant.tokenSha256, 'hex'))) found = grant;
    reject(found && found.expiresAtMs > now, 401);
    return found;
  }
  admit(grant, now) {
    reject(this.#grants.get(grant.tokenSha256) === grant, 403);
    let budget = this.#budgets.get(grant.tokenSha256);
    if (!budget || now - budget.start >= 10000) { budget = { start: now, used: 0 }; this.#budgets.set(grant.tokenSha256, budget); }
    reject(++budget.used <= 256, 429);
  }
  route(grant, recipient, now) {
    address(recipient);
    reject(grant.allowedRecipients.includes(recipient) &&
      [...this.#grants.values()].some(item => item.address === recipient && item.expiresAtMs > now), 403);
  }
}

function respond(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  const bytes = encode(value);
  invariant(bytes.length <= MAX_RESPONSE_BYTES, 'RELAY_RESPONSE_LIMIT');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Connection': 'close' });
  res.end(bytes);
}
async function body(req, maximum = MAX_BODY_BYTES) {
  reject(req.headers['content-type'] === 'application/json' && req.headers['content-encoding'] === undefined);
  reject(req.headers['transfer-encoding'] === undefined && typeof req.headers['content-length'] === 'string');
  const size = Number(req.headers['content-length']);
  reject(Number.isSafeInteger(size) && size > 0 && size <= maximum, 413);
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length; reject(length <= size && length <= maximum, 413); chunks.push(chunk);
  }
  reject(req.complete && length === size);
  return decode(Buffer.concat(chunks, length));
}

/** Creates a standalone HTTP/1.1 TLS-only ciphertext relay. This entry point
 * never accepts plaintext, forwarded-header trust or an insecure fallback.
 */
export function createCiphertextRelay({ key, cert, ...options }) {
  invariant(key && cert, 'RELAY_TLS_REQUIRED');
  return createRelayServer(options,
    (limits, listener) => createHttpsServer({ ...limits, key, cert, minVersion: 'TLSv1.3',
      handshakeTimeout: limits.requestTimeout }, listener),
    req => reject(req.socket.encrypted === true));
}

/** Explicit staging-only managed-edge deployment, NOT a standalone HTTP relay.
 * Render terminates public HTTPS and forwards HTTP to a non-public service port.
 * Forwarded headers are trusted only within that declared platform boundary.
 * Endpoint media/manifest/control encryption and client TLS remain mandatory.
 */
export function createRenderEdgeCiphertextRelay({ publicOrigin, sourceCommit, ...options }) {
  invariant(typeof publicOrigin === 'string' && /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.onrender\.com$/.test(publicOrigin),
    'RELAY_RENDER_ORIGIN_REQUIRED');
  invariant(typeof sourceCommit === 'string' && /^[0-9a-f]{40}$/.test(sourceCommit), 'RELAY_SOURCE_COMMIT_REQUIRED');
  const host = new URL(publicOrigin).host;
  const health = now => ({ status: 'ready', protocol: 1, environment: 'staging',
    transport: 'render-managed-tls-edge', storage: 'ephemeral-sqlite', sourceCommit,
    routingConfigured: options.access.activeCount(now) > 0, productionReady: false });
  return createRelayServer(options, createHttpServer, req => {
    // Render's internal health probes need no credential or forwarded scheme.
    if (req.method === 'GET' && req.url === '/healthz') return;
    reject(req.headers.host === host && req.headers['x-forwarded-proto'] === 'https', 403);
  }, health);
}

function createRelayServer({ store, access, nowUnixMs = Date.now, requestDeadlineMs = 5000,
  sweepIntervalMs = 1000 }, makeServer, admitTransport, health = () => ({ status: 'ready', protocol: 1 })) {
  invariant(store instanceof SqliteCiphertextMailbox && access instanceof RelayAccessPolicy &&
    typeof nowUnixMs === 'function', 'RELAY_CONFIGURATION_REQUIRED');
  integer(requestDeadlineMs, 100, 30000); integer(sweepIntervalMs, 100, 30000);
  let healthy = true, closed = false, lastObserved = 0;
  const observe = () => {
    try { const now = nowUnixMs(); integer(now, lastObserved); lastObserved = now; return now; }
    catch { healthy = false; throw new RequestFailure(503); }
  };
  const server = makeServer({ maxHeaderSize: 8192, requestTimeout: requestDeadlineMs,
    headersTimeout: requestDeadlineMs, connectionsCheckingInterval: 100,
    keepAliveTimeout: 1000, insecureHTTPParser: false }, (req, res) => {
    const deadline = setTimeout(() => { req.destroy(); res.destroy(); }, requestDeadlineMs);
    deadline.unref(); res.once('close', () => clearTimeout(deadline));
    // No logger receives URLs, credentials, message bodies or SQL errors.
    void (async () => {
      reject(!closed && healthy, 503);
      reject(req.httpVersionMajor === 1);
      admitTransport(req);
      reject(req.headers.origin === undefined && req.headers.cookie === undefined, 403);
      reject(req.url && req.url.length < 256 && !/[?#%\\]/.test(req.url));
      const counts = new Map();
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i].toLowerCase(); counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      reject(counts.size <= 32 && counts.get('host') === 1 && [...counts.values()].every(n => n === 1));
      const now = observe();
      if (req.method === 'GET' && req.url === '/healthz') {
        reject(req.headers['transfer-encoding'] === undefined && !Number(req.headers['content-length'] ?? 0));
        // Probe the real store: listener availability alone is not readiness.
        try { store.stats(now); } catch { healthy = false; throw new RequestFailure(503); }
        respond(res, 200, health(now)); return;
      }
      const grant = access.authenticate(req.headers.authorization, now); access.admit(grant, now);
      if (req.method === 'GET' && req.url === '/v1/mailbox') {
        reject(req.headers['transfer-encoding'] === undefined && !Number(req.headers['content-length'] ?? 0));
        respond(res, 200, { messages: store.poll(grant.address, now) }); return;
      }
      const publish = req.method === 'PUT' && req.url === '/v1/bundles';
      const take = req.method === 'POST' && /^\/v1\/bundles\/([0-9a-f]{64})\/take$/.exec(req.url);
      const send = req.method === 'PUT' && /^\/v1\/mailboxes\/([0-9a-f]{64})\/messages$/.exec(req.url);
      const ack = req.method === 'POST' && req.url === '/v1/mailbox/ack';
      const putChunk = req.method === 'PUT' && req.url === '/v1/chunks';
      const readChunk = req.method === 'POST' && req.url === '/v1/chunks/read';
      reject(publish || take || send || ack || putChunk || readChunk, 404);
      if (take || send) access.route(grant, (take || send)[1], now);
      const data = await body(req, putChunk ? MAX_CHUNK_BODY_BYTES : MAX_BODY_BYTES);
      const at = observe(); const current = access.authenticate(req.headers.authorization, at);
      // Operator changes during a slow upload cannot inherit the old grant.
      reject(current === grant, 403);
      if (take || send) access.route(current, (take || send)[1], at);
      if (putChunk) {
        reject(Array.isArray(data.readers) && data.readers.length <= 32);
        for (const reader of data.readers) access.route(current, reader, at);
        respond(res, 200, store.putChunk(grant.address, data, at));
      } else if (readChunk) {
        exact(data, ['owner','request']); access.route(current, data.owner, at);
        respond(res, 200, { ciphertextBase64: Buffer.from(store.readChunk(grant.address, data.owner, data.request, at)).toString('base64') });
      } else if (publish) respond(res, 200, store.publish(grant.address, data, at));
      else if (take) { exact(data, []); respond(res, 200, { bundle: store.take(take[1], at) }); }
      else if (send) respond(res, 200, store.enqueue(grant.address, send[1], data, at));
      else {
        exact(data, ['receiptIds']); store.acknowledge(grant.address, data.receiptIds, at);
        respond(res, 200, { status: 'acknowledged' });
      }
    })().catch(error => {
      let status = error instanceof RequestFailure ? error.status : 400;
      if (/QUOTA|BUSY/.test(error?.code ?? error?.message ?? '')) status = 429;
      else if (/CONFLICT/.test(error?.code ?? error?.message ?? '')) status = 409;
      else if (error?.code?.startsWith?.('ERR_SQLITE') || error?.code === 'SQLITE_ERROR') { healthy = false; status = 503; }
      // Incomplete bodies are not drained indefinitely after rejection.
      res.once('finish', () => req.destroy());
      respond(res, status, { error: 'request-rejected' });
    });
  });
  server.maxConnections = 64; server.maxHeadersCount = 32; server.maxRequestsPerSocket = 1;
  server.setTimeout(requestDeadlineMs, socket => socket.destroy());
  server.on('checkContinue', (req, res) => { respond(res, 417, { error: 'request-rejected' }); res.once('finish', () => req.destroy()); });
  server.on('checkExpectation', (req, res) => { respond(res, 417, { error: 'request-rejected' }); res.once('finish', () => req.destroy()); });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());
  const sweep = setInterval(() => {
    if (closed) return;
    try { store.sweep(observe()); } catch { healthy = false; }
  }, sweepIntervalMs); sweep.unref();
  server.once('close', () => { closed = true; clearInterval(sweep); });
  // Caller owns the store: close the server and its connections before store.close().
  return server;
}
