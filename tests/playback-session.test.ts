import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EndpointPlaybackSession, ControlVerifier, MemoryCheckpointStore, createControlSigningKey,
  signControl, packageRendition, ProgramTimeline, compileProgram,
} from '../src/index.js';
import type { AndroidAudioEvent, AndroidPcmRequest, IOSPcmRequest, LeasePolicy, PlaybackSessionOptions, SignedControl } from '../src/index.js';

type CommonEvent = Exclude<AndroidAudioEvent, { type: 'interrupted' }>;
const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, sessionId: 'session' };
const route = { endpointId: 'endpoint', routeId: 'route', outputId: 'output', generation: 1, kind: 'unknown' as const };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function fixture(platform: 'android' | 'ios', initiallyActive = false) {
  const keys = await createControlSigningKey();
  const controls = new ControlVerifier(scope, new Map([['operator', keys.publicKey]]), new Set(['lease', 'emergency-stop']), new MemoryCheckpointStore());
  const context = { tenantId: scope.tenantId, application: scope.application, parentMessageId: 'private-parent' };
  const media = await packageRendition({ sampleRate: 8000, channels: 2, samples: new Float32Array(16000).fill(0.5) }, 1, context, 'test.wav');
  let now = 1000, allowed = true, reads = 0, resolutions = 0, stops = 0, failCancel = false;
  let listener: ((event: CommonEvent) => void) | undefined;
  const copied: Array<AndroidPcmRequest | IOSPcmRequest> = [];
  const updates: number[][] = [];
  let decodeHook = async () => {};
  let readHook = async () => {};
  const policy: LeasePolicy = { expiresAtMs: 8000, stopAtMs: 8000, fadeMs: 500, maxLinearGain: 0.5 };
  const bridge = {
    subscribe(value: (event: CommonEvent) => void) {
      listener = value;
      if (initiallyActive) value({ type: 'route-active', route, sampleRate: 8000, maxChannels: 2 });
      return () => { listener = undefined; };
    },
    enqueue(request: Readonly<AndroidPcmRequest | IOSPcmRequest>) { copied.push({ ...request, samples: request.samples.slice() }); },
    updateEnvelope(_id: string, gain: number, fade: number, stop: number) { updates.push([gain, fade, stop]); },
    cancel() {},
    cancelAll() { stops++; if (failCancel) throw new Error('driver-stop-failed'); },
  };
  const options: PlaybackSessionOptions = {
    scope, controls, consentedGainCeiling: 0.75, nowUnixMs: () => now,
    // Fixture-only seam: not a real parent E2EE channel or production decoder.
    decodeControlPayload: async () => { await decodeHook(); return { ...policy }; },
    timeline: new ProgramTimeline(1000, compileProgram('program', 8000, [{ id: 'clip', assetId: 'asset', frames: 8000, markerAfter: null }])),
    resolver: { async resolve() {
      resolutions++;
      return { assetId: 'asset', context, manifest: media.privateManifest, sampleRate: 8000, channels: 2, frames: 8000, authorizationValidUntilMs: 9000 };
    } },
    transport: { async read(request) { reads++; await readHook(); return media.ciphertextChunks[request.chunkIndex]!; } },
    authorizePlayback: async () => allowed ? { allowed: true, validUntilMs: 9000 } : { allowed: false },
  };
  // Both bridge event unions differ only in interruption reasons. Disconnect and
  // route events used here are common; separate sink tests cover specific reasons.
  const session = platform === 'android'
    ? EndpointPlaybackSession.android({ ...options, bridge, native: { nowMonotonicMs: () => now + 4000 } })
    : EndpointPlaybackSession.ios({ ...options, bridge: { ...bridge, subscribe: callback => bridge.subscribe(callback) }, native: { nowHostTimeMs: () => now + 4000 } });
  async function control(sequence: number, action = 'lease'): Promise<SignedControl> {
    return signControl({ version: '1.0.0', scope, keyId: 'operator', algorithm: 'ALG-ED25519', epoch: 1, sequence,
      issuedAtMs: 1000, expiresAtMs: 10000, action, payloadCiphertextBase64: 'dGVzdA==' }, keys.privateKey);
  }
  return {
    session, options, copied, updates, policy, control,
    activate(generation = 1) { listener!({ type: 'route-active', route: { ...route, generation }, sampleRate: 8000, maxChannels: 2 }); },
    disconnect() { listener!({ type: 'disconnected' }); },
    setNow(value: number) { now = value; }, deny() { allowed = false; },
    blockDecode(hook: () => Promise<void>) { decodeHook = hook; }, blockRead(hook: () => Promise<void>) { readHook = hook; },
    failCancel() { failCancel = true; },
    get reads() { return reads; }, get stops() { return stops; }, get resolutions() { return resolutions; }, get listener() { return listener; },
  };
}
for (const platform of ['android', 'ios'] as const) {
  test(`${platform} session requires route and signed lease, then decrypts actual media into the sink`, async () => {
    const f = await fixture(platform);
    await assert.rejects(f.session.pump(), /NOT_PLAYING/);
    await assert.rejects(f.session.join(await f.control(1)), /OUTPUT_UNAVAILABLE/);
    f.activate(); await f.session.join(await f.control(1));
    assert.equal(f.session.snapshot().phase, 'playing');
    assert.equal((await f.session.pump()).status, 'scheduled');
    assert.equal(f.copied.length, 1); assert.equal(f.copied[0]!.samples[0], 0.5);
    assert.equal(f.copied[0]!.gainCeiling, 0.5); assert.equal(f.copied[0]!.routeGeneration, 1);
    f.session.close(); assert.equal(f.listener, undefined);
  });
  test(`${platform} session rejects forged authority and has no plaintext fallback`, async () => {
    const f = await fixture(platform); f.activate(); const forged = await f.control(1);
    forged.body.payloadCiphertextBase64 = 'Zm9yZ2Vk';
    await assert.rejects(f.session.join(forged), /AUTHENTICATION_FAILED/);
    assert.equal(f.reads, 0); assert.equal(f.copied.length, 0); assert.equal(f.session.snapshot().phase, 'stopped');
    await f.session.join(await f.control(1)); await f.session.pump(); f.session.close();
  });
  test(`${platform} native disconnect cancels downloads; late completion cannot stop a newly joined generation`, async () => {
    const f = await fixture(platform); f.activate(); await f.session.join(await f.control(1));
    const entered = gate(), blocked = gate(); let first = true;
    f.blockRead(async () => { if (first) { first = false; entered.release(); await blocked.promise; } });
    const old = f.session.pump(); const rejected = assert.rejects(old, /SUPERSEDED|ABORTED/);
    await entered.promise; f.disconnect(); f.activate(3);
    assert.equal(f.session.snapshot().phase, 'stopped'); await assert.rejects(f.session.pump(), /NOT_PLAYING/);
    await f.session.join(await f.control(2)); await f.session.pump(); const stops = f.stops;
    blocked.release(); await rejected;
    assert.equal(f.session.snapshot().phase, 'playing'); assert.equal(f.stops, stops);
    assert.equal(f.copied.length, 1); assert.equal(f.resolutions, 2); f.session.close();
  });
  test(`${platform} route generation change revokes authority and requires explicit signed rejoin`, async () => {
    const f = await fixture(platform, true); await f.session.join(await f.control(1)); await f.session.pump();
    const stops = f.stops; f.activate(1); assert.equal(f.stops, stops);
    f.activate(2); assert.equal(f.session.snapshot().phase, 'stopped');
    await assert.rejects(f.session.renew(await f.control(2)), /NOT_PLAYING/);
    await f.session.join(await f.control(2)); await f.session.pump();
    assert.equal(f.copied.at(-1)!.routeGeneration, 2); assert.equal(f.resolutions, 2); f.session.close();
  });
  test(`${platform} blocked lease work is bounded and cannot rearm after native invalidation`, async () => {
    const f = await fixture(platform); f.activate(); const entered = gate(), blocked = gate();
    f.blockDecode(async () => { entered.release(); await blocked.promise; });
    const joining = f.session.join(await f.control(1)); const rejected = assert.rejects(joining, /SUPERSEDED/);
    await entered.promise; f.disconnect(); f.activate(3);
    await assert.rejects(f.session.join(await f.control(2)), /CONTROL_BUSY/);
    assert.equal(f.session.snapshot().pendingControls, 1);
    blocked.release(); await rejected; assert.equal(f.session.snapshot().phase, 'stopped');
    f.session.close();
  });
  test(`${platform} valid emergency stop supersedes renewal waiting on its private decoder`, async () => {
    const f = await fixture(platform); f.activate(); await f.session.join(await f.control(1)); await f.session.pump();
    const entered = gate(), blocked = gate(); f.blockDecode(async () => { entered.release(); await blocked.promise; });
    const renewing = f.session.renew(await f.control(2)); const rejected = assert.rejects(renewing, /SUPERSEDED/);
    await entered.promise; await f.session.emergencyStop(await f.control(3, 'emergency-stop'));
    assert.equal(f.session.snapshot().stopReason, 'emergency');
    blocked.release(); await rejected; assert.equal(f.session.snapshot().stopReason, 'emergency'); f.session.close();
  });
  test(`${platform} lease expiry during verification never starts native playback`, async () => {
    const f = await fixture(platform); f.activate(); f.blockDecode(async () => { f.setNow(8500); });
    await assert.rejects(f.session.join(await f.control(1)), /EXPIRED/);
    assert.equal(f.copied.length, 0); assert.equal(f.session.snapshot().phase, 'stopped'); f.session.close();
  });
  test(`${platform} expired authority, denied rights and clock rollback all stop the whole session`, async () => {
    for (const failure of ['expiry', 'rights', 'clock']) {
      const f = await fixture(platform); f.activate(); await f.session.join(await f.control(1)); await f.session.pump();
      const stops = f.stops;
      if (failure === 'expiry') f.setNow(8000);
      if (failure === 'rights') f.deny();
      if (failure === 'clock') f.setNow(900);
      await assert.rejects(f.session.pump()); assert.equal(f.session.snapshot().phase, 'stopped'); assert.ok(f.stops > stops);
      f.session.close();
    }
  });
  test(`${platform} stop and zero user gain require explicit rejoin and never resurrect cached PCM`, async () => {
    const f = await fixture(platform); f.activate(); await f.session.join(await f.control(1)); await f.session.pump();
    f.session.setUserGain(0.1); assert.equal(f.updates.at(-1)![0], 0.1);
    f.session.setUserGain(0); assert.equal(f.session.snapshot().phase, 'stopped');
    f.session.setUserGain(0.5); await assert.rejects(f.session.pump(), /NOT_PLAYING/);
    await f.session.join(await f.control(2)); await f.session.pump(); assert.equal(f.resolutions, 2);
    f.session.stop(); f.session.close(); f.session.close(); await assert.rejects(f.session.join(await f.control(3)), /CLOSED/);
  });
  test(`${platform} native cancellation failure still revokes session and pending authority`, async () => {
    const f = await fixture(platform); f.activate(); await f.session.join(await f.control(1));
    f.failCancel(); assert.throws(() => f.disconnect(), /driver-stop-failed/);
    assert.equal(f.session.snapshot().phase, 'stopped'); await assert.rejects(f.session.pump(), /NOT_PLAYING/);
    assert.throws(() => f.session.close()); assert.equal(f.session.snapshot().phase, 'closed');
  });
}
test('session rejects cross-scope control verifier before creating a native sink', async () => {
  const f = await fixture('android');
  assert.throws(() => EndpointPlaybackSession.android({ ...f.options,
    scope: { ...scope, sessionId: 'other' }, bridge: { subscribe() { throw Error('must-not-subscribe'); }, enqueue() {}, updateEnvelope() {}, cancel() {}, cancelAll() {} },
    native: { nowMonotonicMs: () => 5000 },
  }), /SESSION_CONTROL_SCOPE_MISMATCH/); f.session.close();
});
