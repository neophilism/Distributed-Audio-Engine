import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EndpointPlaybackSession, ControlVerifier, MemoryCheckpointStore, createControlSigningKey,
  signControl, packageNormalizedRendition, ProgramTimeline, compileProgram } from '../../dist/src/index.js';
import { KernelBridge } from '../../integrations/signal-parent/tests/kernel-bridge.mjs';

// This uses actual C rendering and cryptographic primitives with fixture-owned
// keys. It is not an Android/iOS driver, parent protocol or physical device test.
for (const platform of ['android', 'ios']) {
  test(`${platform}: endpoint-normalized 44.1 kHz mono is encrypted and rendered as native 8 kHz stereo`, async t => {
    const now = 1000, scope = { tenantId: 'tenant', application: 'distributed-radio', sessionId: 'session' };
    const context = { tenantId: scope.tenantId, application: scope.application, parentMessageId: 'format-parent' };
    const source = { sampleRate: 44100, channels: 1, samples: new Float32Array(44100).fill(0.5) };
    const packaged = await packageNormalizedRendition(source, { sampleRate: 8000, channels: 2 }, 1, context, 'normalized.wav');
    assert.equal(packaged.privateMetadata.frames, 8000); assert.equal(packaged.privateMetadata.channels, 2);
    const signing = await createControlSigningKey();
    const controls = new ControlVerifier(scope, new Map([['issuer', signing.publicKey]]), new Set(['lease']), new MemoryCheckpointStore());
    const payloadKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify({ expiresAtMs: 1500, stopAtMs: 1500, fadeMs: 100, maxLinearGain: 0.5 }));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, payloadKey, plain)); plain.fill(0);
    const control = await signControl({ version: '1.0.0', scope, keyId: 'issuer', algorithm: 'ALG-ED25519',
      epoch: 1, sequence: 1, issuedAtMs: now, expiresAtMs: 2000, action: 'lease',
      payloadCiphertextBase64: Buffer.concat([iv, encrypted]).toString('base64') }, signing.privateKey);
    const bridge = new KernelBridge(() => 5000);
    const options = { scope, controls, consentedGainCeiling: 0.75, nowUnixMs: () => now,
      timeline: new ProgramTimeline(now, compileProgram('program', 8000, [{ id: 'clip', assetId: 'asset', frames: 8000, markerAfter: null }])),
      resolver: { async resolve() { return { assetId: 'asset', context, manifest: packaged.privateManifest,
        sampleRate: 8000, channels: 2, frames: 8000, authorizationValidUntilMs: 5000 }; } },
      transport: { async read(request) { return packaged.ciphertextChunks[request.chunkIndex]; } },
      authorizePlayback: async () => ({ allowed: true, validUntilMs: 5000 }),
      decodeControlPayload: async body => {
        const wire = Buffer.from(body.payloadCiphertextBase64, 'base64');
        const decoded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: wire.subarray(0, 12) }, payloadKey, wire.subarray(12)));
        try { return JSON.parse(new TextDecoder().decode(decoded)); } finally { decoded.fill(0); }
      }, bridge };
    const session = platform === 'android' ? EndpointPlaybackSession.android({ ...options, native: { nowMonotonicMs: bridge.now } })
      : EndpointPlaybackSession.ios({ ...options, native: { nowHostTimeMs: bridge.now } });
    t.after(() => { session.close(); bridge.close(); }); bridge.activate(1);
    await session.join(control); await session.pump();
    assert.ok(bridge.render(5050).every(sample => sample === 0.25));
    assert.ok(bridge.rawViews.every(view => view.every(sample => sample === 0)));
    assert.ok(bridge.render(5500).every(sample => sample === 0));
  });
}
