import { packageRendition, ProgramTimeline, compileProgram, EndpointPlaybackSession } from '../../../dist/src/index.js';
import { SignalPlaybackInbox, createSignalControl } from '../src/playback.mjs';
import { fixture, scope } from './helpers.mjs';

export async function playbackFixture(platform, Bridge) {
  const f = await fixture(); await f.connect(); let allowed = true;
  const origin = f.now; const nativeNow = () => f.now - origin + 5000;
  const context = { tenantId: scope.tenantId, application: scope.application, parentMessageId: 'encrypted-parent' };
  const audio = await packageRendition({ sampleRate: 8000, channels: 2,
    samples: Float32Array.from({ length: 16000 }, (_, i) => i % 2 ? -0.5 : 0.5) }, 1, context, 'test.wav');
  const descriptor = { assetId: 'asset', context, manifest: audio.privateManifest,
    sampleRate: 8000, channels: 2, frames: 8000, authorizationValidUntilMs: f.now + 30_000 };
  const manifestWire = await f.alice.channel.seal(f.bobId, 'manifest', descriptor,
    { messageId: context.parentMessageId, expiresAtMs: f.now + 30_000 });
  const inbox = new SignalPlaybackInbox({ channel: f.bob.channel, sender: f.aliceId, nowUnixMs: () => f.now });
  await inbox.acceptManifest(manifestWire);
  const options = await inbox.sessionOptions({ vault: f.bob.vault, consentedGainCeiling: 0.75,
    timeline: new ProgramTimeline(f.now, compileProgram('program', 8000, [{ id: 'clip', assetId: 'asset', frames: 8000, markerAfter: null }])),
    transport: { async read(request) { return audio.ciphertextChunks[request.chunkIndex]; } },
    authorizePlayback: async () => allowed ? { allowed: true, validUntilMs: f.now + 30_000 } : { allowed: false } });
  let listener; const views = [];
  const bridge = Bridge ? new Bridge(nativeNow) : {
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
    enqueue(request) { views.push({ ...request, samples: request.samples.slice() }); },
    updateEnvelope() {}, cancel() {}, cancelAll() {}, close() {},
    activate(generation) { listener({ type: 'route-active', route: { endpointId: 'endpoint', routeId: 'route', outputId: 'output', generation, kind: 'unknown' }, sampleRate: 8000, maxChannels: 2 }); }
  };
  const session = platform === 'android'
    ? EndpointPlaybackSession.android({ ...options, bridge, native: { nowMonotonicMs: nativeNow } })
    : EndpointPlaybackSession.ios({ ...options, bridge, native: { nowHostTimeMs: nativeNow } });
  bridge.activate(1);
  async function control(sequence = 1, action = 'lease') {
    return createSignalControl(f.alice.channel, f.bobId,
      { epoch: 1, sequence, action, issuedAtMs: f.now, expiresAtMs: f.now + 2000 },
      { expiresAtMs: f.now + 500, stopAtMs: f.now + 500, fadeMs: 100, maxLinearGain: 0.5 });
  }
  return { f, nativeNow, inbox, options, session, bridge, views, manifestWire, descriptor, control,
    deny() { allowed = false; },
    close() { try { session.close(); } finally { bridge.close(); inbox.close(); f.close(); } } };
}
