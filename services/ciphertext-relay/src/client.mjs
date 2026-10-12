import { request } from 'node:https';
import { validateChunkRequest } from '../../../dist/src/index.js';
import { address, clone, decode, encode, exact, integer, invariant, MAX_BODY_BYTES, MAX_RESPONSE_BYTES, MAX_CHUNK_BODY_BYTES, MAX_CHUNK_BYTES, base64 } from './records.mjs';

/** Endpoint transport only. It verifies TLS, never follows redirects or accepts
 * a caller-provided insecure agent, and bounds work before DNS/TLS/body complete.
 * Retry the identical saved delivery packet; do not re-encrypt on an uncertain send.
 */
export class CiphertextRelayClient {
  #origin; #token; #ca; #deadline; #pending = new Set(); #closed = false;
  constructor({ origin, token, ca, timeoutMs = 5000 }) {
    const url = new URL(origin);
    invariant(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname === '/' && (origin === url.origin || origin === url.origin + '/'), 'RELAY_HTTPS_ORIGIN_REQUIRED');
    invariant(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) && Buffer.from(token, 'base64url').toString('base64url') === token, 'RELAY_TOKEN_REQUIRED');
    integer(timeoutMs, 50, 30000);
    invariant(ca === undefined || (typeof ca === 'string' || Buffer.isBuffer(ca)) && Buffer.byteLength(ca) <= 65536, 'RELAY_CA_LIMIT');
    this.#origin = url.origin; this.#token = token; this.#ca = ca === undefined ? undefined : Buffer.from(ca); this.#deadline = timeoutMs;
  }
  #call(method, path, payload, signal) {
    invariant(!this.#closed, 'RELAY_CLIENT_CLOSED'); invariant(this.#pending.size < 8, 'RELAY_CLIENT_BUSY');
    if (signal?.aborted) return Promise.reject(new Error('RELAY_REQUEST_ABORTED'));
    const bytes = payload === undefined ? undefined : encode(payload);
    invariant(!bytes || bytes.length <= (path === '/v1/chunks' ? MAX_CHUNK_BODY_BYTES : MAX_BODY_BYTES), 'RELAY_BODY_LIMIT');
    return new Promise((resolve, reject) => {
      let done = false, req, res, timer;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#pending.delete(cancel); };
      const finish = (error, value) => {
        if (done) return; done = true; cleanup();
        if (error) { res?.destroy(); req?.destroy(); reject(error); } else resolve(value);
      };
      const cancel = () => finish(new Error('RELAY_CLIENT_CLOSED'));
      const abort = () => finish(new Error('RELAY_REQUEST_ABORTED'));
      this.#pending.add(cancel); signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish(new Error('RELAY_REQUEST_TIMEOUT')), this.#deadline); timer.unref();
      try {
        req = request(this.#origin + path, { method, ca: this.#ca, minVersion: 'TLSv1.3', rejectUnauthorized: true,
          agent: false, maxHeaderSize: 8192, headers: {
            Authorization: 'Bearer ' + this.#token, Accept: 'application/json', Connection: 'close',
            ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {})
          } }, response => {
          res = response;
          if (done) { res.destroy(); return; }
          // Do not expose untrusted error bodies, redirects, origins or credentials.
          if (res.statusCode !== 200) { finish(new Error('RELAY_HTTP_' + res.statusCode)); return; }
          const size = Number(res.headers['content-length']);
          if (res.headers['content-type'] !== 'application/json' || res.headers['content-encoding'] !== undefined ||
            res.headers['transfer-encoding'] !== undefined || !Number.isSafeInteger(size) || size < 1 || size > MAX_RESPONSE_BYTES) {
            finish(new Error('RELAY_INVALID_RESPONSE_HEADERS')); return;
          }
          let length = 0; const chunks = [];
          res.on('data', chunk => {
            length += chunk.length;
            if (length > size || length > MAX_RESPONSE_BYTES) finish(new Error('RELAY_RESPONSE_LIMIT'));
            else chunks.push(chunk);
          });
          res.on('aborted', () => finish(new Error('RELAY_RESPONSE_TRUNCATED')));
          res.on('error', () => finish(new Error('RELAY_RESPONSE_FAILED')));
          res.on('end', () => {
            if (done) return;
            if (!res.complete || length !== size) { finish(new Error('RELAY_RESPONSE_TRUNCATED')); return; }
            try { finish(null, decode(Buffer.concat(chunks, length))); }
            catch { finish(new Error('RELAY_INVALID_RESPONSE')); }
          });
        });
        req.on('error', () => finish(new Error('RELAY_TRANSPORT_FAILED')));
        req.end(bytes);
      } catch { finish(new Error('RELAY_TRANSPORT_FAILED')); }
    });
  }
  async publishBundle(bundle, signal) {
    const value = await this.#call('PUT', '/v1/bundles', clone(bundle), signal);
    exact(value, ['bundleId', 'status']); address(value.bundleId);
    invariant(['available', 'taken'].includes(value.status), 'RELAY_INVALID_RESPONSE'); return value;
  }
  async takeBundle(recipient, signal) {
    address(recipient); const value = await this.#call('POST', `/v1/bundles/${recipient}/take`, {}, signal);
    exact(value, ['bundle']); return value.bundle;
  }
  async send(recipient, packet, signal) {
    address(recipient); const value = await this.#call('PUT', `/v1/mailboxes/${recipient}/messages`, clone(packet), signal);
    exact(value, ['receiptId', 'status']); address(value.receiptId);
    invariant(['stored', 'acknowledged'].includes(value.status), 'RELAY_INVALID_RESPONSE'); return value;
  }
  async poll(signal) {
    const value = await this.#call('GET', '/v1/mailbox', undefined, signal);
    exact(value, ['messages']); invariant(Array.isArray(value.messages) && value.messages.length <= 8, 'RELAY_INVALID_RESPONSE');
    for (const entry of value.messages) { exact(entry, ['receiptId', 'sender', 'packet']); address(entry.receiptId); address(entry.sender); }
    // Contents remain untrusted until the endpoint authenticates them.
    return value.messages;
  }
  async acknowledge(receiptIds, signal) {
    invariant(Array.isArray(receiptIds) && receiptIds.length <= 8, 'RELAY_ACK_LIMIT'); receiptIds.forEach(address);
    const value = await this.#call('POST', '/v1/mailbox/ack', { receiptIds: [...receiptIds] }, signal);
    exact(value, ['status']); invariant(value.status === 'acknowledged', 'RELAY_INVALID_RESPONSE');
  }
  async uploadChunk(chunk, signal) {
    const value = await this.#call('PUT', '/v1/chunks', clone(chunk), signal);
    exact(value, ['chunkId','status']); address(value.chunkId); invariant(value.status === 'stored', 'RELAY_INVALID_RESPONSE'); return value;
  }
  chunksFrom(owner, scope) {
    address(owner); exact(scope, ['tenantId','application']); const expected = clone(scope);
    return { read: async (request, signal) => {
      const copy = clone(request); validateChunkRequest(copy);
      invariant(copy.tenantId === expected.tenantId && copy.application === expected.application &&
        copy.expectedBytes <= MAX_CHUNK_BYTES, 'RELAY_CHUNK_SCOPE_OR_SIZE');
      const result = await this.#call('POST', '/v1/chunks/read', { owner, request: copy }, signal);
      exact(result, ['ciphertextBase64']); return base64(result.ciphertextBase64, MAX_CHUNK_BYTES, copy.expectedBytes);
    } };
  }
  close() { if (this.#closed) return; this.#closed = true; for (const cancel of [...this.#pending]) cancel(); this.#token = ''; this.#ca?.fill(0); }
}
