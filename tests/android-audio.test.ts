import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AndroidAudioSink, ControlVerifier, createControlSigningKey, MemoryCheckpointStore, PlaybackAuthority, signControl } from '../src/index.js';
import type { AndroidAudioBridge, AndroidAudioEvent, AndroidPcmRequest, ControlBody, LeasePolicy } from '../src/index.js';

const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, sessionId: 'session' };
const route = { endpointId: 'android', routeId: 'route', outputId: 'speaker', kind: 'bluetooth-speaker' as const, generation: 1 };
class Bridge implements AndroidAudioBridge {
  listener: ((event: AndroidAudioEvent) => void) | undefined;
  copied: AndroidPcmRequest[] = []; raw: Readonly<AndroidPcmRequest>[] = [];
  updates: unknown[][] = []; cancelled: string[] = []; cancelAllCalls = 0; failEnqueue = false; failUpdate = false;
  subscribe(listener: (event: AndroidAudioEvent) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  emit(event: AndroidAudioEvent) { this.listener!(event); }
  enqueue(request: Readonly<AndroidPcmRequest>) {
    this.raw.push(request);
    if (this.failEnqueue) throw Error('native enqueue failed');
    this.copied.push({ ...request, samples: Float32Array.from(request.samples) });
  }
  updateEnvelope(...args: [string, number, number, number]) { if (this.failUpdate) throw Error('native update failed'); this.updates.push(args); }
  cancel(id: string) { this.cancelled.push(id); }
  cancelAll() { this.cancelAllCalls++; }
}
const audio = { sampleRate: 8000, channels: 2, samples: Float32Array.from({ length: 16000 }, (_, i) => i % 2 ? -0.5 : 0.5) };
async function fixture(policy: LeasePolicy = { expiresAtMs: 3000, stopAtMs: 3000, fadeMs: 500, maxLinearGain: 0.6 }) {
  const keys = await createControlSigningKey();
  const verifier = new ControlVerifier(scope, new Map([['key', keys.publicKey]]), new Set(['lease']), new MemoryCheckpointStore());
  const authority = new PlaybackAuthority(verifier, async () => policy, 0.8);
  const body: ControlBody = { version: '1.0.0', scope, keyId: 'key', algorithm: 'ALG-ED25519', epoch: 1, sequence: 1, issuedAtMs: 1000, expiresAtMs: 4000, action: 'lease', payloadCiphertextBase64: 'YWJjZA==' };
  await authority.renew(await signControl(body, keys.privateKey), 1000);
  const bridge = new Bridge(); let now = 1000, monotonic = 5000;
  const sink = new AndroidAudioSink(bridge, authority, { nowUnixMs: () => now, nowMonotonicMs: () => monotonic });
  return { sink, bridge, authority, emit: (event: AndroidAudioEvent) => bridge.emit(event), setTime(a: number, b = monotonic) { now = a; monotonic = b; } };
}
test('active Android route schedules bounded PCM on the monotonic clock and wipes the bridge view', async () => {
  const f = await fixture(); f.emit({ type: 'route-active', route, sampleRate: 8000, maxChannels: 2 });
  const result = f.sink.schedule('clip', audio, 1100, 4, 800);
  assert.deepEqual(result, { frames: 800, startsAtMs: 1100, endsAtMs: 1200, alignment: 'timeline-only' });
  assert.equal(f.bridge.copied[0]!.startAtMonotonicMs, 5100); assert.equal(f.bridge.copied[0]!.stopAtMonotonicMs, 5200);
  assert.equal(f.bridge.copied[0]!.samples[0], 0.5); assert.equal(f.bridge.raw[0]!.samples.every(x => x === 0), true);
});
test('unavailable routes, incompatible formats, overlaps and queue limits fail before native output', async () => {
  const f = await fixture(); assert.throws(() => f.sink.schedule('off', audio, 1000), /UNAVAILABLE/);
  f.emit({ type: 'route-active', route, sampleRate: 16000, maxChannels: 1 });
  assert.throws(() => f.sink.schedule('rate', audio, 1000), /RATE_ADAPTER/);
  f.emit({ type: 'route-active', route: { ...route, generation: 2 }, sampleRate: 8000, maxChannels: 1 });
  assert.throws(() => f.sink.schedule('channels', audio, 1000), /CHANNEL_LAYOUT/);
  f.emit({ type: 'route-active', route: { ...route, generation: 3 }, sampleRate: 8000, maxChannels: 2 });
  f.sink.schedule('one', audio, 1100, 0, 800); assert.throws(() => f.sink.schedule('two', audio, 1150, 0, 800), /OVERLAPPING/);
  const tiny = await fixture(); tiny.emit({ type: 'route-active', route, sampleRate: 8000, maxChannels: 2 });
  const bounded = new AndroidAudioSink(tiny.bridge, tiny.authority, { nowUnixMs: () => 1000, nowMonotonicMs: () => 5000, maxQueuedSamples: 10 });
  tiny.emit({ type: 'route-active', route: { ...route, generation: 2 }, sampleRate: 8000, maxChannels: 2 });
  assert.throws(() => bounded.schedule('large', audio, 1000), /QUEUE_LIMIT/);
});
test('focus, disconnect and route changes invalidate queued output before reactivation', async () => {
  const f = await fixture(); f.emit({ type: 'route-active', route, sampleRate: 8000, maxChannels: 2 }); f.sink.schedule('a', audio, 1100);
  f.emit({ type: 'interrupted', reason: 'focus-loss' }); assert.equal(f.sink.pending, 0); assert.equal(f.sink.outputState().state, 'interrupted');
  assert.throws(() => f.sink.schedule('b', audio, 1100), /UNAVAILABLE/);
  f.emit({ type: 'route-active', route: { ...route, generation: 3 }, sampleRate: 8000, maxChannels: 2 }); f.sink.schedule('b', audio, 1100);
  f.emit({ type: 'completed', id: 'b' }); assert.equal(f.sink.pending, 0);
  f.emit({ type: 'disconnected' }); assert.equal(f.sink.outputState().state, 'unavailable');
});
test('authority refresh contracts native deadlines and never extends queued output', async () => {
  const f = await fixture(); f.emit({ type: 'route-active', route, sampleRate: 8000, maxChannels: 2 }); f.sink.schedule('a', audio, 1200);
  f.setTime(1100, 5100); f.sink.setUserGain(0.2);
  assert.deepEqual(f.bridge.updates.at(-1), ['a', 0.2, 6000, 6000]);
  f.sink.mute(); assert.equal(f.sink.pending, 0); assert.ok(f.bridge.cancelAllCalls >= 2);
});
test('native enqueue and envelope failures leave no locally live output', async () => {
  const first = await fixture(); first.emit({ type: 'route-active', route, sampleRate: 8000, maxChannels: 2 });
  first.bridge.failEnqueue = true; assert.throws(() => first.sink.schedule('a', audio, 1000), /enqueue failed/); assert.equal(first.sink.pending, 0);
  const second = await fixture(); second.emit({ type: 'route-active', route, sampleRate: 8000, maxChannels: 2 }); second.sink.schedule('a', audio, 1100);
  second.bridge.failUpdate = true; second.setTime(1100, 5100); assert.throws(() => second.sink.setUserGain(0.2), /update failed/); assert.equal(second.sink.pending, 0);
});
test('duplicate route events are idempotent while clock rollback and closure fail closed', async () => {
  const f = await fixture(); f.emit({ type: 'route-active', route, sampleRate: 8000, maxChannels: 2 });
  const calls = f.bridge.cancelAllCalls; f.emit({ type: 'route-active', route, sampleRate: 8000, maxChannels: 2 }); assert.equal(f.bridge.cancelAllCalls, calls);
  f.sink.schedule('a', audio, 1100); f.setTime(900, 4900); assert.throws(() => f.sink.refreshAuthority());
  f.sink.close(); f.sink.close(); assert.equal(f.bridge.listener, undefined); assert.throws(() => f.sink.schedule('b', audio, 1100), /CLOSED/);
});
