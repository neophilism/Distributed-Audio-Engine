import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserAudioSink, ControlVerifier, createControlSigningKey, MemoryCheckpointStore, PlaybackAuthority, signControl } from '../src/index.js';
import type { ControlBody, LeasePolicy } from '../src/index.js';
class FakeBuffer {
  readonly data: Float32Array[];
  constructor(readonly numberOfChannels: number, readonly length: number) { this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length)); }
  copyToChannel(source: Float32Array, channel: number) { this.data[channel]!.set(source); }
  getChannelData(channel: number) { return this.data[channel]!; }
}
class FakeSource {
  buffer: FakeBuffer | null = null; onended: (() => void) | null = null; disconnected = false;
  starts: number[][] = []; stops: (number | undefined)[] = [];
  connect() {} disconnect() { this.disconnected = true; }
  start(...args: number[]) { this.starts.push(args); } stop(at?: number) { this.stops.push(at); }
}
class FakeGain {
  disconnected = false;
  events: { kind: string; value?: number; at: number }[] = [];
  gain = {
    cancelScheduledValues: (at: number) => this.events.push({ kind: 'cancel', at }),
    setValueAtTime: (value: number, at: number) => this.events.push({ kind: 'set', value, at }),
    linearRampToValueAtTime: (value: number, at: number) => this.events.push({ kind: 'ramp', value, at }),
  };
  connect() {} disconnect() { this.disconnected = true; }
}
class FakeContext {
  currentTime = 10; state = 'running'; sampleRate = 8000; destination = {};
  sources: FakeSource[] = []; gains: FakeGain[] = []; buffers: FakeBuffer[] = []; listeners = new Set<() => void>();
  addEventListener(_name: string, listener: () => void) { this.listeners.add(listener); }
  removeEventListener(_name: string, listener: () => void) { this.listeners.delete(listener); }
  createBuffer(channels: number, length: number) { const value = new FakeBuffer(channels, length); this.buffers.push(value); return value; }
  createBufferSource() { const value = new FakeSource(); this.sources.push(value); return value; }
  createGain() { const value = new FakeGain(); this.gains.push(value); return value; }
  changeState(state: string) { this.state = state; for (const listener of this.listeners) listener(); }
}
const scope = { tenantId: 'tenant', application: 'scenesignal' as const, sessionId: 'session' };
async function fixture(policy: LeasePolicy = { expiresAtMs: 3000, stopAtMs: 3000, fadeMs: 500, maxLinearGain: 0.6 }, activate = true) {
  const keys = await createControlSigningKey();
  const verifier = new ControlVerifier(scope, new Map([['key', keys.publicKey]]), new Set(['lease', 'emergency-stop']), new MemoryCheckpointStore());
  const authority = new PlaybackAuthority(verifier, async () => policy, 0.8);
  const body: ControlBody = { version: '1.0.0', scope, keyId: 'key', algorithm: 'ALG-ED25519', epoch: 1, sequence: 1, issuedAtMs: 1000, expiresAtMs: 4000, action: 'lease', payloadCiphertextBase64: 'YWJjZA==' };
  if (activate) await authority.renew(await signControl(body, keys.privateKey), 1000);
  const context = new FakeContext(); let now = 1000;
  const sink = new BrowserAudioSink(context as unknown as AudioContext, authority, { nowUnixMs: () => now });
  return { keys, authority, body, context, sink, setNow(value: number) { now = value; } };
}
const audio = { sampleRate: 8000, channels: 2, samples: Float32Array.from({ length: 32000 }, (_, i) => i % 2 ? -0.5 : 0.5) };
test('endpoint schedules interleaved PCM at sample offsets and cleans completed buffers', async () => {
  const f = await fixture(); const result = f.sink.schedule('clip-a', audio, 1100, 4, 800);
  assert.equal(result.frames, 800); assert.equal(result.endsAtMs, 1200); assert.equal(result.alignment, 'timeline-only');
  assert.deepEqual(f.context.sources[0]!.starts, [[10.1, 0, 0.1]]);
  assert.equal(f.context.buffers[0]!.data[0]![0], 0.5); assert.equal(f.context.buffers[0]!.data[1]![0], -0.5);
  f.context.sources[0]!.onended!(); assert.equal(f.sink.pending, 0); assert.equal(f.context.buffers[0]!.data[0]!.every(x => x === 0), true);
});
test('no lease, suspended context, stale schedule, rate mismatch and overlapping output fail closed', async () => {
  const off = await fixture(undefined, false); assert.throws(() => off.sink.schedule('a', audio, 1000), /AUTHORITY/);
  const f = await fixture(); f.context.state = 'suspended'; assert.throws(() => f.sink.schedule('a', audio, 1000), /NOT_RUNNING/); f.context.state = 'running';
  assert.throws(() => f.sink.schedule('a', audio, 999)); assert.throws(() => f.sink.schedule('a', { ...audio, sampleRate: 16000 }, 1000), /RATE_ADAPTER/);
  f.sink.schedule('a', audio, 1100, 0, 800); assert.throws(() => f.sink.schedule('b', audio, 1150, 0, 800), /OVERLAPPING/);
  assert.throws(() => f.sink.schedule('a', audio, 1500), /QUEUE_CONFLICT/); assert.equal(f.context.buffers.length, 1);
});
test('audio graph has its own fade and stop deadline and cannot schedule beyond authority', async () => {
  const f = await fixture({ expiresAtMs: 1800, stopAtMs: 2000, fadeMs: 300, maxLinearGain: 0.6 });
  const result = f.sink.schedule('a', audio, 1200);
  assert.equal(result.frames, 4800); assert.equal(result.endsAtMs, 1800); assert.deepEqual(f.context.sources[0]!.stops, [10.8]);
  assert.deepEqual(f.context.gains[0]!.events.slice(1), [{ kind: 'set', value: 0.6, at: 10 }, { kind: 'set', value: 0.6, at: 10.5 }, { kind: 'ramp', value: 0, at: 10.8 }]);
  assert.throws(() => f.sink.schedule('b', audio, 1800), /NO_AUTHORIZED/);
});
test('gain, mute, leave and emergency changes disconnect output and wipe queued plaintext', async () => {
  const f = await fixture(); f.sink.schedule('a', audio, 1100); f.sink.setUserGain(0.2);
  assert.equal(f.context.gains[0]!.events.filter(x => x.kind === 'set').at(-2)!.value, 0.2);
  f.sink.mute(); assert.equal(f.sink.pending, 0); assert.equal(f.context.gains[0]!.disconnected, true); assert.equal(f.context.buffers[0]!.data[0]!.every(x => x === 0), true);
  f.sink.mute(false); f.sink.schedule('b', audio, 1100);
  await f.authority.emergencyStop(await signControl({ ...f.body, sequence: 2, action: 'emergency-stop' }, f.keys.privateKey), 1000);
  f.sink.refreshAuthority(); assert.equal(f.sink.pending, 0);
  const g = await fixture(); g.sink.schedule('a', audio, 1100); g.sink.leave(); assert.equal(g.sink.pending, 0); assert.throws(() => g.sink.schedule('b', audio, 1100), /AUTHORITY/);
});
test('context lifecycle or output-route changes discard queued output and closing is final', async () => {
  const f = await fixture(); f.sink.schedule('a', audio, 1100); f.context.changeState('suspended'); assert.equal(f.sink.pending, 0);
  f.context.changeState('running'); f.sink.schedule('b', audio, 1100); f.sink.invalidateRoute(); assert.equal(f.sink.pending, 0);
  f.sink.close(); f.sink.close(); assert.equal(f.context.listeners.size, 0); assert.throws(() => f.sink.schedule('c', audio, 1100), /CLOSED/);
});
test('queue bounds apply before allocation and expired authority clears previously queued output', async () => {
  const f = await fixture(); const tiny = new BrowserAudioSink(f.context as unknown as AudioContext, f.authority, { nowUnixMs: () => 1000, maxQueuedSamples: 10 });
  assert.throws(() => tiny.schedule('a', audio, 1000), /QUEUE_LIMIT/); assert.equal(f.context.buffers.length, 0);
  f.sink.schedule('a', audio, 1100); f.setNow(3000); f.context.currentTime = 12; f.sink.refreshAuthority(); assert.equal(f.sink.pending, 0);
});
