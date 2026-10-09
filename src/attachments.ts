import { canonicalJson, identifier, integer, invariant } from './validation.js';
import type { ApplicationScope } from './contracts.js';

const encoder = new TextEncoder();
const PROFILE = 'attachment-chunked-aead@0.1.0' as const;
const DOMAIN = 'E2EESA-ATTACHMENT-MANIFEST-v1';
export const MIN_CHUNK_SIZE = 64 * 1024;
export const MAX_CHUNK_SIZE = 8 * 1024 * 1024;
export const DEFAULT_OBJECT_LIMIT = 64 * 1024 * 1024;
export interface AttachmentContext {
  tenantId: string;
  application: ApplicationScope;
  parentMessageId: string;
}
/** Private: never upload this manifest or its key to ciphertext storage. */
export interface PrivateManifest extends AttachmentContext {
  profile: typeof PROFILE;
  attachmentId: string;
  keyId: string;
  attachmentKeyHex: string;
  aead: 'ALG-AES-256-GCM';
  hash: 'ALG-SHA256';
  noncePrefixHex: string;
  chunkSizeBytes: number;
  chunkCount: number;
  plaintextSizeBytes: number;
  filename: string;
  mediaType: string;
  plaintextHashHex: string;
  storageObjectId: string;
  manifestContextDigestHex: string;
}
export interface EncryptedAttachment {
  privateManifest: PrivateManifest;
  ciphertextChunks: Uint8Array[];
}
function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
function bytes(value: string, length: number): Uint8Array<ArrayBuffer> {
  invariant(typeof value === 'string' && value.length === length * 2 && /^[0-9a-f]+$/.test(value), 'INVALID_HEX');
  return Uint8Array.from(value.match(/.{2}/g)!.map(pair => parseInt(pair, 16)));
}
async function digest(value: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', value)));
}
function randomHex(length: number): string { return hex(crypto.getRandomValues(new Uint8Array(length))); }
function nonce(prefix: string, index: number): Uint8Array<ArrayBuffer> {
  integer(index);
  const result = new Uint8Array(12);
  result.set(bytes(prefix, 4));
  new DataView(result.buffer).setBigUint64(4, BigInt(index), false);
  return result;
}
async function manifestDigest(manifest: PrivateManifest): Promise<string> {
  const { attachmentKeyHex: _key, manifestContextDigestHex: _digest, ...bound } = manifest;
  return digest(encoder.encode(canonicalJson({ domain: DOMAIN, ...bound })));
}
function plaintextLength(manifest: PrivateManifest, index: number): number {
  return Math.min(manifest.chunkSizeBytes, manifest.plaintextSizeBytes - index * manifest.chunkSizeBytes);
}
function associatedData(manifest: PrivateManifest, index: number): Uint8Array<ArrayBuffer> {
  return encoder.encode(canonicalJson({
    attachmentId: manifest.attachmentId,
    manifestContextDigestHex: manifest.manifestContextDigestHex,
    chunkIndex: index,
    chunkCount: manifest.chunkCount,
    plaintextLengthBytes: plaintextLength(manifest, index),
  }));
}
function validateContext(context: AttachmentContext): void {
  identifier(context.tenantId); identifier(context.parentMessageId);
  invariant(context.application === 'scenesignal' || context.application === 'distributed-radio', 'INVALID_APPLICATION');
}
export async function validateManifest(manifest: PrivateManifest, expected: AttachmentContext, maxPlaintextBytes = DEFAULT_OBJECT_LIMIT): Promise<void> {
  invariant(manifest && typeof manifest === 'object', 'INVALID_MANIFEST');
  const allowed = ['tenantId', 'application', 'parentMessageId', 'profile', 'attachmentId', 'keyId', 'attachmentKeyHex', 'aead', 'hash', 'noncePrefixHex', 'chunkSizeBytes', 'chunkCount', 'plaintextSizeBytes', 'filename', 'mediaType', 'plaintextHashHex', 'storageObjectId', 'manifestContextDigestHex'].sort();
  invariant(canonicalJson(Object.keys(manifest).sort()) === canonicalJson(allowed), 'UNKNOWN_MANIFEST_FIELDS');
  validateContext(manifest); validateContext(expected);
  invariant(manifest.tenantId === expected.tenantId && manifest.application === expected.application && manifest.parentMessageId === expected.parentMessageId, 'MANIFEST_SCOPE_MISMATCH');
  invariant(manifest.profile === PROFILE && manifest.aead === 'ALG-AES-256-GCM' && manifest.hash === 'ALG-SHA256', 'UNSUPPORTED_PROFILE');
  identifier(manifest.attachmentId); identifier(manifest.keyId); identifier(manifest.storageObjectId);
  integer(manifest.chunkSizeBytes, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE);
  integer(maxPlaintextBytes, 0, 1024 * 1024 * 1024);
  integer(manifest.plaintextSizeBytes, 0, maxPlaintextBytes); integer(manifest.chunkCount, 1);
  invariant(manifest.chunkCount === Math.max(1, Math.ceil(manifest.plaintextSizeBytes / manifest.chunkSizeBytes)), 'CHUNK_COUNT_MISMATCH');
  invariant(typeof manifest.filename === 'string' && manifest.filename.length <= 1024 && !/[\x00-\x1f]/.test(manifest.filename), 'INVALID_FILENAME');
  invariant(typeof manifest.mediaType === 'string' && manifest.mediaType.length > 0 && manifest.mediaType.length <= 256 && !/[\x00-\x1f]/.test(manifest.mediaType), 'INVALID_MEDIA_TYPE');
  bytes(manifest.attachmentKeyHex, 32); bytes(manifest.noncePrefixHex, 4);
  bytes(manifest.plaintextHashHex, 32); bytes(manifest.manifestContextDigestHex, 32);
  invariant(await manifestDigest(manifest) === manifest.manifestContextDigestHex, 'MANIFEST_DIGEST_MISMATCH');
}
/** Runs at an authorized endpoint. Every call creates a fresh key and object ID. */
export async function encryptAttachment(
  plaintext: Uint8Array,
  options: AttachmentContext & { filename: string; mediaType: string; chunkSizeBytes?: number; maxPlaintextBytes?: number },
): Promise<EncryptedAttachment> {
  validateContext(options);
  const chunkSizeBytes = options.chunkSizeBytes ?? MIN_CHUNK_SIZE;
  integer(chunkSizeBytes, MIN_CHUNK_SIZE, MAX_CHUNK_SIZE);
  const maxPlaintextBytes = options.maxPlaintextBytes ?? DEFAULT_OBJECT_LIMIT;
  integer(maxPlaintextBytes, 0, 1024 * 1024 * 1024); integer(plaintext.byteLength, 0, maxPlaintextBytes);
  // Copy caller-owned buffers so asynchronous hashing/encryption cannot race mutation.
  const input = Uint8Array.from(plaintext);
  const privateManifest: PrivateManifest = {
    tenantId: options.tenantId, application: options.application, parentMessageId: options.parentMessageId,
    profile: PROFILE, attachmentId: randomHex(16), keyId: randomHex(16), attachmentKeyHex: randomHex(32),
    aead: 'ALG-AES-256-GCM', hash: 'ALG-SHA256', noncePrefixHex: randomHex(4), chunkSizeBytes,
    chunkCount: Math.max(1, Math.ceil(input.length / chunkSizeBytes)), plaintextSizeBytes: input.length,
    filename: options.filename, mediaType: options.mediaType, plaintextHashHex: await digest(input),
    storageObjectId: randomHex(16), manifestContextDigestHex: '',
  };
  privateManifest.manifestContextDigestHex = await manifestDigest(privateManifest);
  await validateManifest(privateManifest, options, maxPlaintextBytes);
  const key = await crypto.subtle.importKey('raw', bytes(privateManifest.attachmentKeyHex, 32), 'AES-GCM', false, ['encrypt']);
  const ciphertextChunks: Uint8Array[] = [];
  for (let index = 0; index < privateManifest.chunkCount; index++) {
    const chunk = input.slice(index * chunkSizeBytes, (index + 1) * chunkSizeBytes);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce(privateManifest.noncePrefixHex, index), additionalData: associatedData(privateManifest, index), tagLength: 128 }, key, chunk);
    ciphertextChunks.push(new Uint8Array(ciphertext));
  }
  input.fill(0);
  return { privateManifest, ciphertextChunks };
}
/** Caller must first authenticate the manifest's containing E2EE parent channel. */
export async function decryptAttachment(
  manifest: PrivateManifest, chunks: readonly Uint8Array[], expected: AttachmentContext, maxPlaintextBytes = DEFAULT_OBJECT_LIMIT,
): Promise<Uint8Array> {
  // Snapshot untrusted/caller-owned state before any asynchronous operation.
  const localManifest = structuredClone(manifest);
  integer(maxPlaintextBytes, 0, 1024 * 1024 * 1024);
  integer(localManifest.plaintextSizeBytes, 0, maxPlaintextBytes);
  invariant(chunks.length === localManifest.chunkCount, 'MISSING_CHUNKS');
  // Reject inconsistent public lengths before copying or allocating plaintext.
  for (let index = 0; index < chunks.length; index++) invariant(chunks[index]!.length === plaintextLength(localManifest, index) + 16, 'CIPHERTEXT_LENGTH_MISMATCH');
  const localChunks = chunks.map(chunk => Uint8Array.from(chunk));
  await validateManifest(localManifest, expected, maxPlaintextBytes);
  invariant(localChunks.length === localManifest.chunkCount, 'MISSING_CHUNKS');
  const key = await crypto.subtle.importKey('raw', bytes(localManifest.attachmentKeyHex, 32), 'AES-GCM', false, ['decrypt']);
  const plaintext = new Uint8Array(localManifest.plaintextSizeBytes);
  try {
    for (let index = 0; index < localChunks.length; index++) {
      const chunk = localChunks[index]!;
      invariant(chunk.length === plaintextLength(localManifest, index) + 16, 'CIPHERTEXT_LENGTH_MISMATCH');
      const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce(localManifest.noncePrefixHex, index), additionalData: associatedData(localManifest, index), tagLength: 128 }, key, chunk);
      plaintext.set(new Uint8Array(decoded), index * localManifest.chunkSizeBytes);
    }
    invariant(await digest(plaintext) === localManifest.plaintextHashHex, 'FILE_HASH_MISMATCH');
    return plaintext;
  } catch (error) { plaintext.fill(0); throw error; }
}

/** Endpoint range primitive. The manifest must arrive in an authenticated E2EE parent. */
export class EndpointAttachmentReader {
  private closed = false;
  private constructor(private readonly manifest: PrivateManifest, private readonly key: CryptoKey) {}

  static async open(manifest: PrivateManifest, expected: AttachmentContext, maxPlaintextBytes = DEFAULT_OBJECT_LIMIT): Promise<EndpointAttachmentReader> {
    const local = structuredClone(manifest);
    const context = { ...expected };
    await validateManifest(local, context, maxPlaintextBytes);
    const key = await crypto.subtle.importKey('raw', bytes(local.attachmentKeyHex, 32), 'AES-GCM', false, ['decrypt']);
    // Keep the non-extractable CryptoKey; do not retain the copied raw key string.
    local.attachmentKeyHex = '';
    return new EndpointAttachmentReader(local, key);
  }

  get sizeBytes(): number { return this.manifest.plaintextSizeBytes; }
  get chunkCount(): number { return this.manifest.chunkCount; }
  get chunkSizeBytes(): number { return this.manifest.chunkSizeBytes; }
  get storageObjectId(): string { return this.manifest.storageObjectId; }
  get tenantId(): string { return this.manifest.tenantId; }
  get application(): ApplicationScope { return this.manifest.application; }
  assertOpen(): void { invariant(!this.closed, 'ATTACHMENT_READER_CLOSED'); }
  private check(index: number): void {
    this.assertOpen();
    integer(index, 0, this.chunkCount - 1);
  }
  ciphertextLength(index: number): number { this.check(index); return plaintextLength(this.manifest, index) + 16; }

  async decryptChunk(index: number, ciphertext: Uint8Array): Promise<Uint8Array> {
    this.check(index);
    invariant(ciphertext.length === this.ciphertextLength(index), 'CIPHERTEXT_LENGTH_MISMATCH');
    const local = Uint8Array.from(ciphertext);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce(this.manifest.noncePrefixHex, index), additionalData: associatedData(this.manifest, index), tagLength: 128 }, this.key, local));
    if (this.closed) { plaintext.fill(0); invariant(false, 'ATTACHMENT_READER_CLOSED'); }
    return plaintext;
  }

  async verifyComplete(plaintext: Uint8Array): Promise<void> {
    invariant(!this.closed, 'ATTACHMENT_READER_CLOSED');
    invariant(plaintext.length === this.sizeBytes, 'FILE_LENGTH_MISMATCH');
    const local = Uint8Array.from(plaintext);
    try {
      const actual = await digest(local);
      invariant(!this.closed, 'ATTACHMENT_READER_CLOSED');
      invariant(actual === this.manifest.plaintextHashHex, 'FILE_HASH_MISMATCH');
    } finally { local.fill(0); }
  }
  close(): void { this.closed = true; }
}
