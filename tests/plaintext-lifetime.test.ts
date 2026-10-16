import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptAttachment, decryptAttachment, EndpointAttachmentReader, MIN_CHUNK_SIZE,
  decodeWave, encodePcm16, packageRendition, analyzePcm } from '../src/index.js';
const context = { tenantId: 'tenant', application: 'distributed-radio' as const, parentMessageId: 'parent' };
const options = { ...context, filename: 'private.wav', mediaType: 'audio/wav' };
function view(value: ArrayBuffer | ArrayBufferView): Uint8Array {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

test('owned encryption chunks and imported raw keys are erased after real successful encryption', async t => {
  const plaintext = new Uint8Array(MIN_CHUNK_SIZE + 7).fill(29), chunks: Uint8Array[] = [], keys: Uint8Array[] = [];
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle), importKey = crypto.subtle.importKey.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'encrypt', async (...args: Parameters<typeof encrypt>) => {
    chunks.push(view(args[2])); return encrypt(...args);
  });
  t.mock.method(crypto.subtle, 'importKey', async (...args: Parameters<typeof importKey>) => {
    if (args[0] === 'raw') keys.push(view(args[1] as ArrayBuffer));
    return Reflect.apply(importKey, crypto.subtle, args);
  });
  const encrypted = await encryptAttachment(plaintext, options);
  assert.equal(chunks.length, 2); assert.ok(chunks.every(chunk => chunk.every(n => n === 0)));
  assert.ok(keys.length > 0 && keys.every(key => key.every(n => n === 0)));
  assert.ok(plaintext.every(n => n === 29)); assert.equal(encrypted.privateManifest.attachmentKeyHex.length, 64);
  assert.deepEqual(await decryptAttachment(encrypted.privateManifest, encrypted.ciphertextChunks, context), plaintext);
});
test('a rejected real crypto call erases owned plaintext rather than retaining a failed partial operation', async t => {
  const plaintext = new Uint8Array(97).fill(41), observed: Uint8Array[] = [];
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'digest', async (...args: Parameters<typeof digest>) => {
    const bytes = view(args[1]); if (bytes.length === plaintext.length) observed.push(bytes);
    return digest(...args);
  });
  t.mock.method(crypto.subtle, 'encrypt', async (...args: Parameters<typeof crypto.subtle.encrypt>) => {
    observed.push(view(args[2])); throw new Error('CRYPTO_PROVIDER_FAILURE');
  });
  await assert.rejects(encryptAttachment(plaintext, options), /CRYPTO_PROVIDER_FAILURE/);
  assert.ok(observed.length >= 2 && observed.every(bytes => bytes.every(n => n === 0)));
  assert.ok(plaintext.every(n => n === 41));
});
test('initial hashing failure also erases the owned input copy', async t => {
  let owned: Uint8Array | undefined;
  t.mock.method(crypto.subtle, 'digest', async (...args: Parameters<typeof crypto.subtle.digest>) => {
    owned = view(args[1]); throw new Error('HASH_PROVIDER_FAILURE');
  });
  const input = new Uint8Array([11, 12, 13]);
  await assert.rejects(encryptAttachment(input, options), /HASH_PROVIDER_FAILURE/);
  assert.ok(owned && owned.every(n => n === 0)); assert.deepEqual(input, new Uint8Array([11, 12, 13]));
});
test('decryption erases per-chunk intermediates while returning the caller-owned authenticated result', async t => {
  const input = new Uint8Array(MIN_CHUNK_SIZE + 7).fill(59), encrypted = await encryptAttachment(input, options);
  const decoded: Uint8Array[] = [], decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'decrypt', async (...args: Parameters<typeof decrypt>) => {
    const result = await decrypt(...args); decoded.push(new Uint8Array(result)); return result;
  });
  const result = await decryptAttachment(encrypted.privateManifest, encrypted.ciphertextChunks, context);
  assert.deepEqual(result, input); assert.equal(decoded.length, 2);
  assert.ok(decoded.every(chunk => chunk.every(n => n === 0)));
  assert.equal(encrypted.privateManifest.attachmentKeyHex.length, 64);
});
test('invalid manifest chunk geometry rejects before copying untrusted ciphertext', async () => {
  const encrypted = await encryptAttachment(new Uint8Array([1]), options);
  const chunk = encrypted.ciphertextChunks[0]!; let copied = 0;
  Object.defineProperty(chunk, Symbol.iterator, { value: function* () { copied++; yield* Uint8Array.prototype.values.call(this); } });
  await assert.rejects(decryptAttachment({ ...encrypted.privateManifest, chunkSizeBytes: 1 }, [chunk], context));
  assert.equal(copied, 0);
});
test('oversized WAVE expansion rejects before allocating its decoded sample buffer', () => {
  const header = encodePcm16({ sampleRate: 8000, channels: 1, samples: new Float32Array([0]) });
  const size = 32 * 1024 * 1024 + 2, wave = new Uint8Array(44 + size); wave.set(header.subarray(0, 44));
  const fields = new DataView(wave.buffer); fields.setUint32(4, wave.length - 8, true); fields.setUint32(40, size, true);
  const original = globalThis.Float32Array; let allocated = false;
  globalThis.Float32Array = new Proxy(original, { construct() { allocated = true; throw new Error('ALLOCATION_ATTEMPTED'); } });
  try { assert.throws(() => decodeWave(wave), /PCM_EXPANSION_LIMIT/); assert.equal(allocated, false); }
  finally { globalThis.Float32Array = original; }
});
test('rendition temporary PCM is erased after both successful and failed encryption without touching source samples', async t => {
  const source = { sampleRate: 8000, channels: 1, samples: new Float32Array([0.25, -0.25]) };
  const original = globalThis.Float32Array, allocated: Float32Array[] = [];
  globalThis.Float32Array = new Proxy(original, { construct(target, args) {
    const buffer = Reflect.construct(target, args) as Float32Array; allocated.push(buffer); return buffer;
  } });
  t.after(() => { globalThis.Float32Array = original; });
  const output = await packageRendition(source, 0.5, context, 'quiet.wav');
  assert.equal(output.privateMetadata.samplePeak, 0.125);
  assert.ok(allocated.length >= 2 && allocated.every(buffer => buffer.every(n => n === 0)));
  t.mock.method(crypto.subtle, 'encrypt', async () => { throw Error('FAILED_ENCRYPTION'); });
  await assert.rejects(packageRendition(source, 0.5, context, 'failed.wav'), /FAILED_ENCRYPTION/);
  assert.ok(allocated.every(buffer => buffer.every(n => n === 0)));
  assert.deepEqual([...source.samples], [0.25, -0.25]);
});
test('shared plaintext and shared PCM require an explicit endpoint-owned snapshot', async () => {
  await assert.rejects(encryptAttachment(new Uint8Array(new SharedArrayBuffer(16)), options), /INVALID_PLAINTEXT_BUFFER/);
  assert.throws(() => analyzePcm({ sampleRate: 8000, channels: 1, samples: new Float32Array(new SharedArrayBuffer(16)) }), /INVALID_PCM_BUFFER/);
  assert.throws(() => decodeWave(new Uint8Array(new SharedArrayBuffer(44))), /INVALID_WAVE_BUFFER/);
});
test('closing a reader during actual native decryption withholds and erases the late plaintext', async t => {
  const encrypted = await encryptAttachment(new Uint8Array([1, 2, 3]), options);
  const reader = await EndpointAttachmentReader.open(encrypted.privateManifest, context);
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle); let decoded: Uint8Array | undefined;
  let release!: () => void, entered!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  t.mock.method(crypto.subtle, 'decrypt', async (...args: Parameters<typeof decrypt>) => {
    const result = await decrypt(...args); decoded = new Uint8Array(result); entered(); await hold; return result;
  });
  const pending = reader.decryptChunk(0, encrypted.ciphertextChunks[0]!);
  const rejected = assert.rejects(pending, /ATTACHMENT_READER_CLOSED/);
  await ready; reader.close(); release(); await rejected;
  assert.ok(decoded && decoded.every(n => n === 0));
});

test('raw key import failure erases the temporary key bytes', async t => {
  let raw: Uint8Array | undefined;
  t.mock.method(crypto.subtle, 'importKey', async (...args: Parameters<typeof crypto.subtle.importKey>) => {
    raw = view(args[1] as ArrayBuffer); throw Error('KEY_IMPORT_FAILED');
  });
  await assert.rejects(encryptAttachment(new Uint8Array([17, 18]), options), /KEY_IMPORT_FAILED/);
  assert.ok(raw && raw.length === 32 && raw.every(n => n === 0));
});
test('corrupt later ciphertext never leaves the already decrypted intermediate chunk readable', async t => {
  const encrypted = await encryptAttachment(new Uint8Array(MIN_CHUNK_SIZE + 3).fill(7), options);
  encrypted.ciphertextChunks[1]![0] = encrypted.ciphertextChunks[1]![0]! ^ 1;
  const decrypt = crypto.subtle.decrypt.bind(crypto.subtle), retained: Uint8Array[] = [];
  t.mock.method(crypto.subtle, 'decrypt', async (...args: Parameters<typeof decrypt>) => {
    const decoded = await decrypt(...args); retained.push(new Uint8Array(decoded)); return decoded;
  });
  await assert.rejects(decryptAttachment(encrypted.privateManifest, encrypted.ciphertextChunks, context));
  assert.equal(retained.length, 1); assert.ok(retained[0]!.every(n => n === 0));
});
test('nonfinite WAVE samples erase partially decoded PCM before rejection', () => {
  const wave = new Uint8Array(52), v = new DataView(wave.buffer);
  const tag = (at: number, text: string) => { for (let i = 0; i < 4; i++) wave[at + i] = text.charCodeAt(i); };
  tag(0, 'RIFF'); v.setUint32(4, 44, true); tag(8, 'WAVE'); tag(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 3, true); v.setUint16(22, 1, true); v.setUint32(24, 8000, true); v.setUint32(28, 32000, true);
  v.setUint16(32, 4, true); v.setUint16(34, 32, true); tag(36, 'data'); v.setUint32(40, 8, true);
  v.setFloat32(44, 0.5, true); v.setFloat32(48, NaN, true);
  const original = globalThis.Float32Array; let retained: Float32Array | undefined;
  globalThis.Float32Array = new Proxy(original, { construct(target, args) {
    retained = Reflect.construct(target, args) as Float32Array; return retained;
  } });
  try { assert.throws(() => decodeWave(wave), /INVALID_NUMBER/); assert.ok(retained && retained.every(n => n === 0)); }
  finally { globalThis.Float32Array = original; }
});
