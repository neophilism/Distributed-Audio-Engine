import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileProgram, EndpointProgramPlayer, packageRendition, ProgramTimeline } from '../src/index.js';
import type { EndpointMediaAsset, PcmAudio, ProgramPlayerOptions } from '../src/index.js';
const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, sessionId: 'session' };
async function fixture(overrides: Partial<ProgramPlayerOptions> = {}) {
  let now = 1200; let allowed = true;
  const packages = new Map<string, Awaited<ReturnType<typeof packageRendition>>>(); const descriptors = new Map<string, EndpointMediaAsset>();
  for (const [id, value] of [['a', 0.25], ['b', -0.25]] as const) {
    const context = { tenantId: scope.tenantId, application: scope.application, parentMessageId: `parent-${id}` };
    const pkg = await packageRendition({ sampleRate: 8000, channels: 1, samples: new Float32Array(8000).fill(value) }, 1, context, `${id}.wav`);
    packages.set(pkg.privateManifest.storageObjectId, pkg);
    descriptors.set(`asset-${id}`, { assetId: `asset-${id}`, context, manifest: pkg.privateManifest, sampleRate: 8000, channels: 1, frames: 8000, authorizationValidUntilMs: 10000 });
  }
  const timeline = new ProgramTimeline(1000, compileProgram('program', 8000, [{ id: 'a', assetId: 'asset-a', frames: 8000, markerAfter: 'a-end' }, { id: 'b', assetId: 'asset-b', frames: 8000, markerAfter: 'b-end' }]));
  const resolves: string[] = []; let fetches = 0; let stops = 0;
  const scheduled: { id: string; at: number; offset: number; frames: number; samples: Float32Array }[] = [];
  const sink = {
    horizonMs: 500,
    schedule(id: string, audio: PcmAudio, at: number, offset: number, requested: number) {
      const frames = Math.min(requested, Math.floor((now + this.horizonMs - at) * audio.sampleRate / 1000));
      assert.ok(frames > 0); scheduled.push({ id, at, offset, frames, samples: audio.samples.slice(offset, offset + frames) });
      return { frames, startsAtMs: at, endsAtMs: at + frames * 1000 / audio.sampleRate, alignment: 'timeline-only' as const };
    },
    stopAll() { stops++; },
  };
  const options: ProgramPlayerOptions = {
    scope, timeline, sink, nowUnixMs: () => now,
    authorizePlayback: async () => allowed ? { allowed: true, validUntilMs: 10000 } : { allowed: false },
    resolver: { async resolve(id) { resolves.push(id); return descriptors.get(id)!; } },
    transport: { async read(request) { fetches++; return packages.get(request.storageObjectId)!.ciphertextChunks[request.chunkIndex]!; } },
    ...overrides,
  };
  const player = new EndpointProgramPlayer(options);
  return { player, options, timeline, descriptors, scheduled, resolves, setNow(value: number) { now = value; }, setAllowed(value: boolean) { allowed = value; }, get fetches() { return fetches; }, get stops() { return stops; } };
}
test('encrypted endpoint joins at the current frame, keeps a bounded queue and follows the next programmed asset', async () => {
  const f = await fixture(); const first = await f.player.pump();
  assert.equal(first.status, 'scheduled'); assert.equal(f.scheduled[0]!.at, 1250); assert.equal(f.scheduled[0]!.offset, 2000);
  assert.equal(f.scheduled[0]!.samples[0], 0.25); assert.equal((await f.player.pump()).status, 'buffered'); assert.equal(f.fetches, 1);
  f.setNow(1600); await f.player.pump(); assert.equal(f.scheduled[1]!.at, 1700); assert.equal(f.fetches, 1);
  f.setNow(1900); await f.player.pump(); assert.equal(f.scheduled[2]!.at, 2000); assert.equal(f.scheduled[2]!.offset, 0); assert.equal(f.scheduled[2]!.samples[0], -0.25);
  assert.deepEqual(f.resolves, ['asset-a', 'asset-b']);
});
test('slow delivery crossing an asset boundary never schedules the stale content', async () => {
  const f = await fixture(); const original = f.options.transport.read;
  f.options.transport.read = async request => { f.setNow(2100); return original(request); };
  assert.equal((await f.player.pump()).status, 'retry-current-target'); assert.equal(f.scheduled.length, 0);
  await f.player.pump(); assert.equal(f.scheduled[0]!.at, 2150); assert.equal(f.scheduled[0]!.offset, 1200); assert.equal(f.scheduled[0]!.samples[0], -0.25);
});
test('rights are checked before delivery and after the final await, and cap scheduled output', async () => {
  const denied = await fixture(); denied.setAllowed(false); await assert.rejects(denied.player.pump(), /RIGHTS_DENIED/); assert.equal(denied.fetches, 0);
  let calls = 0;
  const short = await fixture({ authorizePlayback: async () => ({ allowed: true, validUntilMs: ++calls === 1 ? 10000 : 1300 }) });
  await short.player.pump(); assert.equal(short.scheduled[0]!.frames, 400);
  const late = await fixture(); let lateCalls = 0;
  late.options.authorizePlayback = async () => { if (++lateCalls === 2) late.setNow(1500); return { allowed: true, validUntilMs: 1400 }; };
  // The player snapshots function references, so use a new player with the altered adapter.
  const latePlayer = new EndpointProgramPlayer(late.options); await assert.rejects(latePlayer.pump()); assert.equal(late.scheduled.length, 0);
});
test('cross-scope, tampered ciphertext and authenticated metadata mismatch never reach the sink', async () => {
  const wrong = await fixture(); wrong.descriptors.get('asset-a')!.context.tenantId = 'other'; await assert.rejects(wrong.player.pump(), /SCOPE_MISMATCH/);
  const corrupt = await fixture(); corrupt.options.transport.read = async () => new Uint8Array(16060); await assert.rejects(corrupt.player.pump()); assert.equal(corrupt.scheduled.length, 0);
  const metadata = await fixture(); metadata.descriptors.get('asset-a')!.frames = 8001; await assert.rejects(metadata.player.pump(), /METADATA_MISMATCH/); assert.equal(metadata.scheduled.length, 0);
  const timing = await fixture(); timing.timeline.publish(compileProgram('new', 8000, [{ id: 'a', assetId: 'asset-a', frames: 7999, markerAfter: null }]), 16000n, 1200); timing.setNow(3000);
  await assert.rejects(timing.player.pump(), /TIMELINE_ASSET_MISMATCH/);
});
test('interruption cancels in-flight delivery; a late prior operation cannot stop a new generation', async () => {
  const f = await fixture(); let release!: () => void; let entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const original = f.options.transport.read; let first = true;
  f.options.transport.read = async request => { if (first) { first = false; entered(); await blocked; } return original(request); };
  const old = f.player.pump(); await started; assert.equal((await f.player.pump()).status, 'busy'); f.player.interrupt();
  await f.player.pump(); const stops = f.stops; release(); await assert.rejects(old); assert.equal(f.stops, stops); assert.equal(f.scheduled.length, 1);
});
test('clock rollback, expired descriptor, and close fail without restarting prior cached playback', async () => {
  const f = await fixture(); await f.player.pump(); f.setNow(1100); await assert.rejects(f.player.pump()); assert.equal(f.stops, 1);
  const expired = await fixture(); expired.descriptors.get('asset-a')!.authorizationValidUntilMs = 1200; await assert.rejects(expired.player.pump()); assert.equal(expired.fetches, 0);
  const closed = await fixture(); closed.player.close(); closed.player.close(); await assert.rejects(closed.player.pump(), /CLOSED/); assert.equal(closed.scheduled.length, 0);
});
test('fractional frame scheduling preserves a continuous sample cursor across queued fragments', () => {
  const timeline = new ProgramTimeline(1000, compileProgram('p', 44100, [{ id: 'clip', assetId: 'asset', frames: 44100, markerAfter: null }]));
  const frame = 12345n; assert.equal(timeline.targetAtFrame(frame).offsetFrames, 12345); assert.equal(timeline.timeAtFrame(frame), 1000 + 12345 * 1000 / 44100);
  assert.throws(() => timeline.timeAtFrame(10n ** 30n)); assert.throws(() => timeline.targetAtFrame(-1n));
});
