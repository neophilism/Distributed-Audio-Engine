import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CachingChunkTransport, compileProgram, CoordinatorChunkTransport, CoordinatorMonitor, ControlVerifier, createControlSigningKey, DisciplinedClock, EndpointCiphertextCache, EndpointProgramPlayer, packageRendition, PlaybackAuthority, ProgramTimeline, RightsCatalog, signControl } from '../src/index.js';
import { SqliteCheckpointStore, SqliteCiphertextCacheStore } from '../src/node/index.js';
import type { ChunkRequest, ControlBody, EndpointMediaAsset, PcmAudio } from '../src/index.js';
const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, sessionId: 'session' };
async function pipeline() {
  const keys = await createControlSigningKey(); const checkpoints = new SqliteCheckpointStore(':memory:'); const cacheStore = new SqliteCiphertextCacheStore(':memory:');
  let mono = 0; let sequence = 0; let localAlive = true; let corrupt = false; let stopped = 0;
  const payloads = new Map<number, unknown>();
  // Authenticated parent/control channel doubles supply private descriptors and payloads. No key protocol is asserted here.
  const decode = async (body: ControlBody): Promise<unknown> => structuredClone(payloads.get(body.sequence));
  const verifier = new ControlVerifier(scope, new Map([['primary', keys.publicKey]]), new Set(['clock-response', 'coordinator-lease', 'lease', 'emergency-stop']), checkpoints);
  const clock = new DisciplinedClock(scope, verifier, decode, () => mono);
  const now = () => clock.nowUnixMs(20);
  async function command(action: string, payload: unknown, atMs: number) {
    payloads.set(++sequence, payload);
    return signControl({ version: '1.0.0', scope, keyId: 'primary', algorithm: 'ALG-ED25519', epoch: 1, sequence, issuedAtMs: atMs, expiresAtMs: atMs + 10000, action, payloadCiphertextBase64: 'YWJjZA==' }, keys.privateKey);
  }
  for (const start of [0, 1000, 2000]) {
    mono = start; const probe = clock.beginProbe(); mono += 10;
    await clock.accept(await command('clock-response', { nonce: probe.nonce, receivedUnixMs: 100000 + start + 5, sentUnixMs: 100000 + start + 5, uncertaintyMs: 0.1 }, 100000 + mono), 100000 + mono);
  }
  const monitor = new CoordinatorMonitor(scope, 'program', verifier, decode);
  await monitor.accept(await command('coordinator-lease', { coordinatorId: 'local', programId: 'program', term: 1, expiresAtMs: now() + 2000 }, now()), now());
  const authority = new PlaybackAuthority(verifier, decode, 0.8);
  await authority.renew(await command('lease', { expiresAtMs: now() + 2000, stopAtMs: now() + 2000, fadeMs: 200, maxLinearGain: 0.6 }, now()), now());
  const descriptors = new Map<string, EndpointMediaAsset>(); const chunks = new Map<string, Uint8Array[]>();
  const identity = { tenantId: scope.tenantId, application: scope.application, identityId: 'creator' }; const actor = { ...identity, deviceId: 'device', expiresAtMs: 110000, permissions: ['rights:write' as const] };
  const rights = new RightsCatalog(identity);
  for (const [id, value] of [['a', 0.25], ['b', -0.25]] as const) {
    const context = { tenantId: scope.tenantId, application: scope.application, parentMessageId: `private-parent-${id}` };
    const encrypted = await packageRendition({ sampleRate: 8000, channels: 1, samples: new Float32Array(8000).fill(value) }, 1, context, `private-${id}.wav`);
    chunks.set(encrypted.privateManifest.storageObjectId, encrypted.ciphertextChunks);
    descriptors.set(`asset-${id}`, { assetId: `asset-${id}`, context, manifest: encrypted.privateManifest, sampleRate: 8000, channels: 1, frames: 8000, authorizationValidUntilMs: 108000 });
    rights.add(actor, { id: `rights-${id}`, assetId: `asset-${id}`, layer: 'spoken-work', uses: ['stream', 'cache'], territories: ['US'], validFromMs: 100000, validUntilMs: 108000, authorizationEvidenceRef: 'sha256:' + 'a'.repeat(64), revoked: false }, now());
  }
  const localRequests: ChunkRequest[] = []; const remoteRequests: ChunkRequest[] = [];
  const coordinated = new CoordinatorChunkTransport(monitor, new Map([['local', { async read(request: ChunkRequest) { localRequests.push(request); if (!localAlive) throw new Error('local host lost'); const bytes = Uint8Array.from(chunks.get(request.storageObjectId)![request.chunkIndex]!); if (corrupt) bytes[0] = bytes[0]! ^ 1; return bytes; } }]]), { async read(request) { remoteRequests.push(request); return chunks.get(request.storageObjectId)![request.chunkIndex]!; } }, { nowUnixMs: now });
  const cache = new EndpointCiphertextCache(cacheStore, scope, { maxBytes: 1024 * 1024, maxEntries: 8, maxRetentionMs: 10000 });
  const transport = new CachingChunkTransport(cache, coordinated, now, 5000);
  const scheduled: { atMs: number; frames: number; firstSample: number; gain: number }[] = [];
  const sink = {
    horizonMs: 500,
    schedule(_id: string, audio: PcmAudio, atMs: number, offset: number, requested: number) {
      const envelope = authority.envelopeAt(now()); assert.ok(envelope);
      const frames = Math.min(requested, Math.floor((Math.min(now() + 500, envelope.deadlineMs) - atMs) * audio.sampleRate / 1000)); assert.ok(frames > 0);
      scheduled.push({ atMs, frames, firstSample: audio.samples[offset]!, gain: authority.gainAt(now()) });
      return { frames, startsAtMs: atMs, endsAtMs: atMs + frames * 1000 / audio.sampleRate, alignment: 'timeline-only' as const };
    },
    stopAll() { stopped++; },
  };
  const timeline = new ProgramTimeline(100000, compileProgram('program', 8000, [{ id: 'a', assetId: 'asset-a', frames: 8000, markerAfter: 'a-end' }, { id: 'b', assetId: 'asset-b', frames: 8000, markerAfter: 'b-end' }]));
  const player = new EndpointProgramPlayer({ scope, timeline, sink, transport, nowUnixMs: now, resolver: { async resolve(id) { return descriptors.get(id)!; } }, authorizePlayback: async (assetId, atMs) => rights.evaluate({ assetId, layers: ['spoken-work'], uses: ['stream', 'cache'], territory: 'US', atMs }).allowed ? { allowed: true, validUntilMs: 108000 } : { allowed: false } });
  return { player, clock, authority, monitor, rights, actor, cache, transport, coordinated, scheduled, localRequests, remoteRequests, now, command, setMono(value: number) { mono = value; }, setLocalAlive(value: boolean) { localAlive = value; }, setCorrupt(value: boolean) { corrupt = value; }, get stopped() { return stopped; }, close() { player.close(); transport.close(); coordinated.close(); checkpoints.close(); cacheStore.close(); } };
}
test('shared clock, signed authority, rights, opaque cache, local failover and encrypted program playback compose', async () => {
  const p = await pipeline();
  try {
    await p.player.pump(); assert.equal(p.scheduled[0]!.atMs, 102060); assert.equal(p.scheduled[0]!.firstSample, 0.25); assert.equal(p.scheduled[0]!.gain, 0.6); assert.equal(p.localRequests.length, 1);
    p.setMono(2700); await p.player.pump(); assert.equal(p.localRequests.length, 1);
    p.setLocalAlive(false); p.setMono(3100); await p.player.pump(); assert.equal(p.scheduled.at(-1)!.firstSample, -0.25); assert.equal(p.remoteRequests.length, 1); assert.equal(p.cache.stats(p.now()).entries, 2);
    const disclosed = JSON.stringify([...p.localRequests, ...p.remoteRequests]); assert.equal(disclosed.includes('private-'), false); assert.equal(disclosed.includes('attachmentKey'), false);
    p.setMono(3400); p.rights.revoke(p.actor, 'rights-b', p.now()); await assert.rejects(p.player.pump(), /RIGHTS_DENIED/); assert.ok(p.stopped > 0);
    await p.authority.emergencyStop(await p.command('emergency-stop', null, p.now()), p.now()); assert.equal(p.authority.gainAt(p.now()), 0);
  } finally { p.close(); }
});
test('corrupt local ciphertext never reaches PCM; discarding the failed host permits authenticated fallback', async () => {
  const p = await pipeline();
  try {
    p.setCorrupt(true); await assert.rejects(p.player.pump()); assert.equal(p.scheduled.length, 0); assert.equal(p.cache.stats(p.now()).entries, 0);
    p.monitor.disconnect(); await p.player.pump(); assert.equal(p.remoteRequests.length, 1); assert.equal(p.scheduled[0]!.firstSample, 0.25);
  } finally { p.close(); }
});
