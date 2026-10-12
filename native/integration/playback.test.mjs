import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  EndpointPlaybackSession, ControlVerifier, MemoryCheckpointStore, createControlSigningKey,
  signControl, packageRendition, ProgramTimeline, compileProgram,
} from '../../dist/src/index.js';

const native = createRequire(import.meta.url)(process.env.DAE_TEST_ADDON);
const scope = { tenantId: 'test-tenant', application: 'distributed-radio', sessionId: 'test-session' };
const ok = status => assert.equal(status, 0, 'native kernel rejected the integration request');

// This adapter is a real synchronous Node-API/C handoff, NOT AudioTrack,
// AVAudioEngine, a mobile JavaScript runtime, or a physical output device.
class KernelBridge {
  handle = native.create(8000, 2);
  generation = 0;
  nextToken = 0n;
  ids = new Map();
  rawViews = [];
  listener;
  constructor(now) { this.now = now; }
  subscribe(listener) { this.listener = listener; return () => { this.listener = undefined; }; }
  activate(generation) {
    ok(native.activate(this.handle, BigInt(generation), this.now())); this.generation = generation;
    this.listener({ type: 'route-active', route: { endpointId: 'test-endpoint', routeId: 'test-route',
      outputId: 'test-output', generation, kind: 'unknown' }, sampleRate: 8000, maxChannels: 2 });
  }
  enqueue(request) {
    assert.equal(request.sampleRate, 8000); assert.equal(request.channels, 2);
    assert.equal(request.samples.length, request.frames * 2); assert.equal(this.ids.has(request.id), false);
    const token = ++this.nextToken;
    ok(native.enqueue(this.handle, token, BigInt(request.routeGeneration), request.samples, this.now(),
      request.startAtMonotonicMs ?? request.startAtHostTimeMs,
      request.fadeStartMonotonicMs ?? request.fadeStartHostTimeMs,
      request.stopAtMonotonicMs ?? request.stopAtHostTimeMs, request.gainCeiling));
    this.ids.set(request.id, token); this.rawViews.push(request.samples);
  }
  updateEnvelope(id, gain, fade, stop) {
    const token = this.ids.get(id);
    if (token) ok(native.update(this.handle, BigInt(this.generation), token, gain, fade, stop));
  }
  cancel(id) {
    const token = this.ids.get(id);
    if (token) { ok(native.cancel(this.handle, BigInt(this.generation), token)); this.ids.delete(id); }
    this.drain();
  }
  cancelAll() { ok(native.cancelAll(this.handle)); this.ids.clear(); }
  disconnect() { ok(native.deactivate(this.handle)); this.ids.clear(); this.listener({ type: 'disconnected' }); }
  render(time, frames = 80, generation = this.generation) {
    const result = native.render(this.handle, BigInt(generation), time, frames); this.drain(); return result;
  }
  drain() {
    const tokens = new Set(native.drain(this.handle));
    for (const [id, token] of this.ids) if (tokens.has(token)) {
      this.ids.delete(id); this.listener?.({ type: 'completed', id });
    }
  }
  close() { native.close(this.handle); }
}
async function fixture(platform) {
  let now = 1000, allowed = true, validUntil = 9000;
  const bridge = new KernelBridge(() => now + 4000);
  const signing = await createControlSigningKey();
  const verifier = new ControlVerifier(scope, new Map([['test-issuer', signing.publicKey]]), new Set(['lease', 'emergency-stop']), new MemoryCheckpointStore());
  // Temporary locally provisioned test key only. This tests AEAD rejection, not
  // key agreement, an E2EESA pairwise/group protocol or production key delivery.
  const payloadKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const context = { tenantId: scope.tenantId, application: scope.application, parentMessageId: 'test-parent' };
  const packaged = await packageRendition({ sampleRate: 8000, channels: 2,
    samples: Float32Array.from({ length: 16000 }, (_, index) => index % 2 ? -0.5 : 0.5) }, 1, context, 'fixture.wav');
  const options = {
    scope, controls: verifier, consentedGainCeiling: 0.75, nowUnixMs: () => now,
    timeline: new ProgramTimeline(1000, compileProgram('test-program', 8000, [{ id: 'clip', assetId: 'asset', frames: 8000, markerAfter: null }])),
    resolver: { async resolve() { return { assetId: 'asset', context, manifest: packaged.privateManifest,
      sampleRate: 8000, channels: 2, frames: 8000, authorizationValidUntilMs: validUntil }; } },
    transport: { async read(request) { return packaged.ciphertextChunks[request.chunkIndex]; } },
    authorizePlayback: async () => allowed ? { allowed: true, validUntilMs: validUntil } : { allowed: false },
    decodeControlPayload: async body => {
      const wire = Buffer.from(body.payloadCiphertextBase64, 'base64');
      const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: wire.subarray(0, 12) }, payloadKey, wire.subarray(12)));
      try { return JSON.parse(new TextDecoder().decode(plaintext)); } finally { plaintext.fill(0); }
    },
    bridge,
  };
  const session = platform === 'android'
    ? EndpointPlaybackSession.android({ ...options, native: { nowMonotonicMs: bridge.now } })
    : EndpointPlaybackSession.ios({ ...options, native: { nowHostTimeMs: bridge.now } });
  async function control(sequence, { expires = 1500, action = 'lease', corruptPayload = false } = {}) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify({ expiresAtMs: expires, stopAtMs: expires, fadeMs: 100, maxLinearGain: 0.5 }));
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, payloadKey, plain)); plain.fill(0);
    if (corruptPayload) cipher[0] ^= 1;
    return signControl({ version: '1.0.0', scope, keyId: 'test-issuer', algorithm: 'ALG-ED25519', epoch: 1, sequence,
      issuedAtMs: 1000, expiresAtMs: 10000, action,
      payloadCiphertextBase64: Buffer.concat([iv, cipher]).toString('base64') }, signing.privateKey);
  }
  bridge.activate(1);
  return { session, bridge, control, packaged, setNow(value) { now = value; }, deny() { allowed = false; },
    expireRecipientAt(value) { validUntil = value; }, close() { try { session.close(); } finally { bridge.close(); } } };
}
const silent = result => assert.ok(result.samples.every(sample => sample === 0), 'expected native silence');
for (const platform of ['android', 'ios']) {
  test(`${platform}: actual signed lease and encrypted media reach the production C renderer`, async t => {
    const f = await fixture(platform); t.after(() => f.close());
    await f.session.join(await f.control(1)); await f.session.pump();
    assert.ok(f.bridge.rawViews[0].every(sample => sample === 0), 'temporary JS PCM must already be wiped');
    assert.ok(native.inspect(f.bridge.handle).samples > 0, 'native-owned PCM survives the JS wipe');
    const result = f.bridge.render(5050); ok(result.status);
    assert.equal(result.samples[0], 0.25); assert.equal(result.samples[1], -0.25);
  });
  test(`${platform}: native fade and hard stop work without another JS pump or clock tick`, async t => {
    const f = await fixture(platform); t.after(() => f.close());
    await f.session.join(await f.control(1)); await f.session.pump();
    assert.equal(f.bridge.render(5450).samples[0], 0.125);
    silent(f.bridge.render(5500)); assert.equal(native.inspect(f.bridge.handle).samples, 0);
  });
  test(`${platform}: renewing authority cannot extend or amplify already queued native PCM`, async t => {
    const f = await fixture(platform); t.after(() => f.close());
    await f.session.join(await f.control(1)); await f.session.pump();
    f.setNow(1100); f.session.setUserGain(0.2);
    await f.session.renew(await f.control(2, { expires: 6000 })); f.session.setUserGain(0.7);
    assert.ok(Math.abs(f.bridge.render(5200).samples[0] - 0.1) < 1e-7);
    silent(f.bridge.render(5500));
  });
  test(`${platform}: forged controls and authenticated-but-corrupt private payloads never enqueue`, async t => {
    const f = await fixture(platform); t.after(() => f.close());
    const forged = await f.control(1); forged.body.scope.sessionId = 'wrong-session';
    await assert.rejects(f.session.join(forged));
    await assert.rejects(f.session.join(await f.control(1, { corruptPayload: true })));
    assert.equal(native.inspect(f.bridge.handle).samples, 0); assert.equal(f.bridge.rawViews.length, 0);
  });
  test(`${platform}: media corruption and rights revocation prevent native output`, async t => {
    const f = await fixture(platform); t.after(() => f.close());
    await f.session.join(await f.control(1)); f.packaged.ciphertextChunks[0][0] ^= 1;
    await assert.rejects(f.session.pump()); silent(f.bridge.render(5050));
    f.packaged.ciphertextChunks[0][0] ^= 1;
    f.setNow(1100); await f.session.join(await f.control(2)); await f.session.pump();
    f.deny(); await assert.rejects(f.session.pump()); silent(f.bridge.render(5200));
  });
  test(`${platform}: recipient expiry caps the native buffer independently of a longer lease`, async t => {
    const f = await fixture(platform); t.after(() => f.close());
    f.expireRecipientAt(1200); await f.session.join(await f.control(1)); await f.session.pump();
    assert.equal(f.bridge.render(5050).samples[0], 0.25); silent(f.bridge.render(5200));
  });
  test(`${platform}: authenticated emergency cancellation clears the actual native queue`, async t => {
    const f = await fixture(platform); t.after(() => f.close());
    await f.session.join(await f.control(1)); await f.session.pump();
    await f.session.emergencyStop(await f.control(2, { action: 'emergency-stop' }));
    assert.equal(native.inspect(f.bridge.handle).samples, 0); silent(f.bridge.render(5050));
  });
  test(`${platform}: reconnect rejects stale native generations and does not auto-resume`, async t => {
    const f = await fixture(platform); t.after(() => f.close());
    await f.session.join(await f.control(1)); await f.session.pump(); const oldId = [...f.bridge.ids.keys()][0];
    f.bridge.disconnect(); f.bridge.activate(3); await assert.rejects(f.session.pump());
    await f.session.join(await f.control(2)); await f.session.pump();
    f.bridge.listener({ type: 'completed', id: oldId });
    const stale = f.bridge.render(5050, 80, 1); assert.notEqual(stale.status, 0); silent(stale);
    const current = f.bridge.render(5050); ok(current.status); assert.equal(current.samples[0], 0.25);
  });
}
test('native adapter rejects malformed views, shared/detached buffers, invalid lengths and closed handles', () => {
  const handle = native.create(8000, 2); ok(native.activate(handle, 1n, 5000));
  const enqueue = samples => native.enqueue(handle, 1n, 1n, samples, 5000, 5000, 5100, 5200, 0.5);
  assert.throws(() => enqueue(new Uint8Array(3200)));
  assert.throws(() => enqueue(new Float32Array(new SharedArrayBuffer(12800))));
  const detached = new Float32Array(3200); structuredClone(detached.buffer, { transfer: [detached.buffer] });
  assert.throws(() => enqueue(detached));
  assert.throws(() => native.render(handle, 1n, 5000, 1e12));
  assert.throws(() => native.render(handle, 1n, 5000, -1));
  assert.throws(() => native.activate({}, 1n, 5000));
  native.close(handle); native.close(handle); assert.throws(() => native.inspect(handle));
});
