import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePcm, convertPcmFormat, packageNormalizedRendition, decryptAttachment, decodeWave } from '../src/index.js';
import type { PcmAudio, PcmFormatTarget, PcmConversionOptions } from '../src/index.js';
const context = { tenantId: 'tenant', application: 'distributed-radio' as const, parentMessageId: 'normalized-media' };
const constant = (sampleRate = 8000, channels = 1, frames = 32, value = 0.25): PcmAudio =>
  ({ sampleRate, channels, samples: new Float32Array(frames * channels).fill(value) });
const tone = (sampleRate: number, frequency: number, seconds = 0.2): PcmAudio => ({ sampleRate, channels: 1,
  samples: Float32Array.from({ length: Math.round(sampleRate * seconds) }, (_, i) => 0.5 * Math.sin(2 * Math.PI * frequency * i / sampleRate)) });
const rms = (samples: Float32Array) => Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);

test('PCM format: equal rate identity makes an independent exact owned copy', async () => {
  const source = constant(48000, 2); source.samples.set([0.1, -0.7, 0, 1]); const before = source.samples.slice();
  const result = await convertPcmFormat(source, { sampleRate: 48000, channels: 2 });
  assert.deepEqual(result.audio.samples, before); assert.notEqual(result.audio.samples.buffer, source.samples.buffer);
  assert.equal(result.conversion.algorithm, 'identity-rate'); assert.equal(result.conversion.peakAttenuation, 1);
  result.audio.samples[0] = 0; assert.deepEqual(source.samples, before);
});
test('PCM format: mono duplicates explicitly, stereo averages without raising digital gain', async () => {
  const mono = { sampleRate: 8000, channels: 1, samples: new Float32Array([0.5, -0.25]) };
  const stereo = await convertPcmFormat(mono, { sampleRate: 8000, channels: 2 });
  assert.deepEqual([...stereo.audio.samples], [0.5, 0.5, -0.25, -0.25]);
  const combined = await convertPcmFormat({ sampleRate: 8000, channels: 2, samples: new Float32Array([1, -1, 0.5, 0.25]) },
    { sampleRate: 8000, channels: 1 });
  assert.deepEqual([...combined.audio.samples], [0, 0.375]);
});
test('PCM format: multichannel routing must be explicit and each output has a bounded absolute matrix sum', async () => {
  const source = { sampleRate: 8000, channels: 3, samples: new Float32Array([0.25, 0.5, -0.75]) };
  await assert.rejects(convertPcmFormat(source, { sampleRate: 8000, channels: 2 }), /MATRIX_REQUIRED/);
  const routed = await convertPcmFormat(source, { sampleRate: 8000, channels: 2, channelMatrix: [[0, 0, 1], [0.5, -0.5, 0]] });
  assert.deepEqual([...routed.audio.samples], [-0.75, -0.125]);
  for (const matrix of [[[1, 1, 0]], [[NaN, 0, 0]], [[0, 0]], [[]]])
    await assert.rejects(convertPcmFormat(source, { sampleRate: 8000, channels: 1, channelMatrix: matrix }));
});
test('PCM format: common rational sample rates yield exact rounded frame counts and preserve DC', async () => {
  const rates = [8000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000, 176400, 192000];
  for (const from of rates) for (const to of [8000, 44100, 48000]) {
    const source = constant(from, 1, 31); const converted = await convertPcmFormat(source, { sampleRate: to, channels: 1 });
    assert.equal(converted.audio.samples.length, Math.max(1, Math.round(31 * to / from)));
    assert.ok(converted.audio.samples.every(value => Math.abs(value - 0.25) < 1e-6));
    assert.ok(Math.abs(converted.conversion.durationErrorSeconds) <= 1 / to);
  }
});
test('PCM format: interior low-frequency tones retain amplitude and phase after declared uniform attenuation', async () => {
  for (const [from, to] of [[48000, 8000], [44100, 48000], [8000, 48000], [48000, 44100]] as const) {
    const converted = await convertPcmFormat(tone(from, 1000), { sampleRate: to, channels: 1 });
    const start = Math.ceil(to * 0.05), end = converted.audio.samples.length - start;
    let error = 0;
    for (let i = start; i < end; i++) {
      const expected = 0.5 * converted.conversion.peakAttenuation * Math.sin(2 * Math.PI * 1000 * i / to);
      error += (converted.audio.samples[i]! - expected) ** 2;
    }
    assert.ok(Math.sqrt(error / (end - start)) < 0.00003, `${from}->${to} tone error`);
    assert.ok(converted.conversion.peakAttenuation > 0.95 && converted.conversion.peakAttenuation <= 1);
  }
});
test('PCM format: downsampling rejects a 7 kHz alias at 8 kHz rather than dropping samples', async () => {
  const converted = await convertPcmFormat(tone(48000, 7000), { sampleRate: 8000, channels: 1 });
  const interior = converted.audio.samples.slice(400, -400);
  assert.ok(rms(interior) < 0.00001); // >90 dB below the input RMS in this exact fixture.
  const naive = Float32Array.from({ length: interior.length }, (_, i) => 0.5 * Math.sin(2 * Math.PI * 7000 * (i + 400) / 8000));
  assert.ok(rms(naive) > 0.3);
});
test('PCM format: full-scale discontinuities never yield clipped or boosted output peaks', async () => {
  const source = { sampleRate: 8000, channels: 1, samples: Float32Array.from({ length: 256 }, (_, i) => i < 128 ? -1 : 1) };
  const result = await convertPcmFormat(source, { sampleRate: 48000, channels: 1 });
  assert.ok(result.conversion.peakAttenuation > 0 && result.conversion.peakAttenuation < 1);
  assert.ok(result.audio.samples.every(value => Number.isFinite(value) && Math.abs(value) <= 1));
  assert.equal(analyzePcm(result.audio).samplePeak, 1);
});
test('PCM format: silence and one-frame input remain finite through extreme supported ratios', async () => {
  for (const source of [constant(192000, 1, 1, 0), constant(192000, 1, 1, 0.5), constant(8000, 2, 1, 0)]) {
    const result = await convertPcmFormat(source, { sampleRate: source.sampleRate === 8000 ? 192000 : 8000, channels: source.channels });
    assert.ok(result.audio.samples.length >= source.channels); assert.ok(result.audio.samples.every(Number.isFinite));
    assert.equal(result.conversion.peakAttenuation, 1);
  }
});
test('PCM format: output and work budgets reject before any plaintext copy or output allocation', async () => {
  const source = constant(8000, 1, 100); const original = globalThis.Float32Array; let allocated = false;
  globalThis.Float32Array = new Proxy(original, { construct() { allocated = true; throw Error('ALLOCATION_ATTEMPTED'); } });
  try {
    await assert.rejects(convertPcmFormat(source, { sampleRate: 48000, channels: 2 }, { maxOutputBytes: 4 }), /OUTPUT_LIMIT/);
    await assert.rejects(convertPcmFormat(source, { sampleRate: 48000, channels: 1 }, { maxOperations: 1 }), /WORK_LIMIT/);
    assert.equal(allocated, false);
  } finally { globalThis.Float32Array = original; }
});
test('PCM format: unsupported complex rate ratios are explicit rather than unbounded filter tables', async () => {
  await assert.rejects(convertPcmFormat(constant(44101), { sampleRate: 48001, channels: 1 }), /RATE_RATIO_UNSUPPORTED/);
});
test('PCM format: mutated caller samples, matrix and target cannot change an in-flight conversion', async () => {
  const source = constant(8000, 1, 4096), matrix = [[1], [0.5]], target = { sampleRate: 48000, channels: 2, channelMatrix: matrix };
  const pending = convertPcmFormat(source, target);
  source.samples.fill(-1); matrix[0]![0] = 0; target.sampleRate = 16000; target.channels = 1;
  const result = await pending; assert.equal(result.audio.sampleRate, 48000); assert.equal(result.audio.channels, 2);
  assert.ok(result.audio.samples.every((value, index) => Math.abs(value - (index % 2 ? 0.125 : 0.25)) < 1e-6));
});
test('PCM format: cancelled work clears owned buffers, preserves the caller and never returns partial PCM', async t => {
  const source = constant(44100, 1, 4410), original = globalThis.Float32Array, owned: Float32Array[] = [];
  globalThis.Float32Array = new Proxy(original, { construct(target, args) {
    const output = Reflect.construct(target, args) as Float32Array; owned.push(output); return output;
  } }); t.after(() => { globalThis.Float32Array = original; });
  const signal = new AbortController(); const pending = convertPcmFormat(source, { sampleRate: 48000, channels: 2 }, { signal: signal.signal });
  signal.abort(); await assert.rejects(pending, /CONVERSION_ABORTED/);
  assert.ok(owned.length >= 2 && owned.every(buffer => buffer.every(value => value === 0)));
  assert.ok(source.samples.every(value => value === 0.25));
});
test('PCM format: successful work clears only temporary input and preserves owned output', async t => {
  const source = constant(), original = globalThis.Float32Array, owned: Float32Array[] = [];
  globalThis.Float32Array = new Proxy(original, { construct(target, args) {
    const output = Reflect.construct(target, args) as Float32Array; owned.push(output); return output;
  } }); t.after(() => { globalThis.Float32Array = original; });
  const result = await convertPcmFormat(source, { sampleRate: 48000, channels: 1 });
  assert.ok(result.audio.samples.some(value => value > 0));
  assert.ok(owned.filter(buffer => buffer !== result.audio.samples).every(buffer => buffer.every(value => value === 0)));
});
test('PCM format: failed workspace allocation clears the already-owned input snapshot', async t => {
  const source = constant(), float = globalThis.Float32Array, double = globalThis.Float64Array; let retained: Float32Array | undefined;
  globalThis.Float32Array = new Proxy(float, { construct(target, args) { retained = Reflect.construct(target, args); return retained!; } });
  globalThis.Float64Array = new Proxy(double, { construct() { throw Error('WORKSPACE_ALLOCATION_FAILED'); } });
  t.after(() => { globalThis.Float32Array = float; globalThis.Float64Array = double; });
  await assert.rejects(convertPcmFormat(source, { sampleRate: 8000, channels: 1 }), /WORKSPACE_ALLOCATION_FAILED/);
  assert.ok(retained && retained.every(value => value === 0));
});
test('PCM format: invalid options, shared memory, nonfinite samples and pre-abort fail closed', async () => {
  const source = constant(), abort = new AbortController(); abort.abort();
  await assert.rejects(convertPcmFormat(source, { sampleRate: 8000, channels: 1 }, { signal: abort.signal }), /CONVERSION_ABORTED/);
  for (const value of [7999, 192001, 8000.5, NaN]) await assert.rejects(convertPcmFormat(source, { sampleRate: value, channels: 1 }));
  for (const value of [0, 9, 1.5, NaN]) await assert.rejects(convertPcmFormat(source, { sampleRate: 8000, channels: value }));
  await assert.rejects(convertPcmFormat(source, { sampleRate: 8000, channels: 1, secret: 'no' } as PcmFormatTarget), /OPTIONS/);
  await assert.rejects(convertPcmFormat(source, { sampleRate: 8000, channels: 1 }, { maxOutputBytes: 67108865 }));
  await assert.rejects(convertPcmFormat(source, { sampleRate: 8000, channels: 1 }, { maxOperations: 1000000001 }));
  await assert.rejects(convertPcmFormat({ ...source, samples: new Float32Array(new SharedArrayBuffer(16)) }, { sampleRate: 8000, channels: 1 }), /PCM_BUFFER/);
  await assert.rejects(convertPcmFormat({ ...source, samples: new Float32Array([NaN]) }, { sampleRate: 8000, channels: 1 }));
});
test('PCM format: actual encrypted normalized rendition binds its new format and returns no clear samples', async () => {
  const source = constant(44100, 1, 4410, 0.5), target = { sampleRate: 8000, channels: 2 };
  const result = await packageNormalizedRendition(source, target, 0.5, context, 'normalized.wav');
  const wave = await decryptAttachment(result.privateManifest, result.ciphertextChunks, context);
  try {
    const decoded = decodeWave(wave);
    assert.equal(decoded.sampleRate, 8000); assert.equal(decoded.channels, 2); assert.equal(decoded.samples.length, 1600);
    assert.ok(decoded.samples.every(value => value === 0.25)); assert.equal(result.privateMetadata.frames, 800);
    assert.equal(result.privateMetadata.sampleRate, 8000); assert.equal(result.conversion.sourceSampleRate, 44100);
    assert.equal('audio' in result, false); assert.equal('samples' in result, false);
    assert.equal(result.conversion.realtimeQualified, false); decoded.samples.fill(0);
  } finally { wave.fill(0); }
  const next = await packageNormalizedRendition(source, target, 0.5, context, 'normalized.wav');
  assert.notEqual(result.privateManifest.attachmentKeyHex, next.privateManifest.attachmentKeyHex);
  assert.notEqual(result.privateManifest.storageObjectId, next.privateManifest.storageObjectId);
});
test('PCM format: packaging clears converted and derived PCM on crypto failure', async t => {
  const source = constant(), original = globalThis.Float32Array, owned: Float32Array[] = [];
  globalThis.Float32Array = new Proxy(original, { construct(target, args) {
    const output = Reflect.construct(target, args) as Float32Array; owned.push(output); return output;
  } }); t.after(() => { globalThis.Float32Array = original; });
  t.mock.method(crypto.subtle, 'encrypt', async () => { throw Error('ENCRYPTION_FAILED'); });
  await assert.rejects(packageNormalizedRendition(source, { sampleRate: 8000, channels: 1 }, 1, context, 'failed.wav'), /ENCRYPTION_FAILED/);
  assert.ok(owned.length >= 4 && owned.every(buffer => buffer.every(value => value === 0)));
});
test('PCM format: cancellation during real encryption withholds result even when caller changes its options', async t => {
  const source = constant(), controller = new AbortController(), options: PcmConversionOptions = { signal: controller.signal };
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  t.mock.method(crypto.subtle, 'encrypt', async (...args: Parameters<typeof encrypt>) => {
    const result = await encrypt(...args); controller.abort(); delete options.signal; return result;
  });
  await assert.rejects(packageNormalizedRendition(source, { sampleRate: 8000, channels: 1 }, 1, context, 'cancelled.wav', options), /CONVERSION_ABORTED/);
});
test('PCM format: private parent context is snapshotted before conversion yields', async () => {
  const mutable = { ...context };
  const pending = packageNormalizedRendition(constant(), { sampleRate: 16000, channels: 1 }, 1, mutable, 'bound.wav');
  mutable.parentMessageId = 'tampered';
  const result = await pending; assert.equal(result.privateManifest.parentMessageId, context.parentMessageId);
});
