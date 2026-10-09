import type { ApplicationScope } from './contracts.js';
import { DEFAULT_OBJECT_LIMIT, EndpointAttachmentReader, MAX_CHUNK_SIZE } from './attachments.js';
import { identifier, integer, invariant } from './validation.js';

/** The transport sees opaque identifiers, sizes and ciphertext, never keys or private metadata. */
export interface ChunkRequest {
  tenantId: string;
  application: ApplicationScope;
  storageObjectId: string;
  chunkIndex: number;
  expectedBytes: number;
}
export interface CiphertextChunkTransport {
  read(request: ChunkRequest, signal?: AbortSignal): Promise<Uint8Array>;
}
export function validateChunkRequest(request: ChunkRequest): void {
  invariant(Object.keys(request).sort().join(',') === 'application,chunkIndex,expectedBytes,storageObjectId,tenantId', 'INVALID_CHUNK_REQUEST');
  identifier(request.tenantId); identifier(request.storageObjectId);
  invariant(request.application === 'scenesignal' || request.application === 'distributed-radio', 'INVALID_APPLICATION');
  integer(request.chunkIndex, 0, 16383); integer(request.expectedBytes, 16, MAX_CHUNK_SIZE + 16);
}
function notAborted(signal?: AbortSignal): void { invariant(!signal?.aborted, 'DELIVERY_ABORTED'); }

/** No plaintext is returned on cancellation, tag failure or whole-file hash failure. */
export async function readAttachmentRange(
  reader: EndpointAttachmentReader, transport: CiphertextChunkTransport,
  startByte: number, endByte: number, options: { signal?: AbortSignal; maxReadBytes?: number } = {},
): Promise<{ plaintext: Uint8Array; integrity: 'chunk-authenticated' | 'whole-file-verified' }> {
  reader.assertOpen();
  const maxReadBytes = options.maxReadBytes ?? DEFAULT_OBJECT_LIMIT;
  integer(maxReadBytes, 0, DEFAULT_OBJECT_LIMIT);
  integer(startByte, 0, reader.sizeBytes); integer(endByte, startByte, reader.sizeBytes);
  integer(endByte - startByte, 0, maxReadBytes); notAborted(options.signal);
  const result = new Uint8Array(endByte - startByte);
  const whole = startByte === 0 && endByte === reader.sizeBytes;
  // The empty file still needs its authenticated zero-length chunk.
  const first = Math.floor(startByte / reader.chunkSizeBytes);
  const last = endByte > startByte ? Math.floor((endByte - 1) / reader.chunkSizeBytes) : first - 1;
  const indices = reader.sizeBytes === 0 && whole ? [0] : Array.from({ length: Math.max(0, last - first + 1) }, (_, i) => first + i);
  try {
    for (const index of indices) {
      notAborted(options.signal);
      const request: ChunkRequest = { tenantId: reader.tenantId, application: reader.application, storageObjectId: reader.storageObjectId, chunkIndex: index, expectedBytes: reader.ciphertextLength(index) };
      const ciphertext = await transport.read(request, options.signal);
      notAborted(options.signal);
      const chunk = await reader.decryptChunk(index, ciphertext);
      try {
        notAborted(options.signal);
        const base = index * reader.chunkSizeBytes;
        const from = Math.max(startByte, base); const to = Math.min(endByte, base + chunk.length);
        result.set(chunk.subarray(from - base, to - base), from - startByte);
      } finally { chunk.fill(0); }
    }
    if (whole) await reader.verifyComplete(result);
    notAborted(options.signal); reader.assertOpen();
    return { plaintext: result, integrity: whole ? 'whole-file-verified' : 'chunk-authenticated' };
  } catch (error) { result.fill(0); throw error; }
}

export interface FetchTransportOptions {
  origin: string;
  /** Adapter supplies an opaque, scoped download capability, never an attachment key. */
  authorize: (request: Readonly<ChunkRequest>, signal?: AbortSignal) => Promise<string>;
  fetch?: typeof globalThis.fetch;
}
/** Bounded HTTPS ciphertext retrieval. Redirects, cookies and referrers are disabled. */
export class FetchChunkTransport implements CiphertextChunkTransport {
  private readonly origin: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly authorize: FetchTransportOptions['authorize'];
  constructor(options: FetchTransportOptions) {
    const url = new URL(options.origin);
    invariant(url.protocol === 'https:' && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '', 'INVALID_CIPHERTEXT_ORIGIN');
    this.origin = url.origin; this.fetcher = options.fetch ?? globalThis.fetch; this.authorize = options.authorize;
  }
  async read(request: ChunkRequest, signal?: AbortSignal): Promise<Uint8Array> {
    const local = { ...request }; validateChunkRequest(local); notAborted(signal);
    const capability = await this.authorize(Object.freeze({ ...local }), signal);
    invariant(typeof capability === 'string' && /^[A-Za-z0-9._~+\/-]{1,4096}={0,2}$/.test(capability), 'INVALID_DOWNLOAD_CAPABILITY');
    notAborted(signal);
    const path = [local.application, local.tenantId, 'objects', local.storageObjectId, 'chunks', String(local.chunkIndex)].map(encodeURIComponent).join('/');
    const response = await this.fetcher(`${this.origin}/${path}`, { method: 'GET', headers: { Authorization: `Bearer ${capability}` }, redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', ...(signal ? { signal } : {}) });
    invariant(response.status === 200 && response.body, 'CIPHERTEXT_FETCH_FAILED');
    const length = response.headers.get('content-length');
    if (length !== null) invariant(/^\d+$/.test(length) && Number(length) === local.expectedBytes, 'CIPHERTEXT_LENGTH_MISMATCH');
    const body = response.body.getReader(); const out = new Uint8Array(local.expectedBytes); let offset = 0;
    try {
      while (true) {
        notAborted(signal); const next = await body.read(); notAborted(signal);
        if (next.done) break;
        invariant(offset + next.value.length <= out.length, 'CIPHERTEXT_RESPONSE_TOO_LARGE');
        out.set(next.value, offset); offset += next.value.length;
      }
      invariant(offset === out.length, 'CIPHERTEXT_LENGTH_MISMATCH');
      return out;
    } catch (error) { await body.cancel().catch(() => undefined); throw error; }
    finally { body.releaseLock(); }
  }
}
