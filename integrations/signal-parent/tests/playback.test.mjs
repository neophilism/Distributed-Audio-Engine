import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packageRendition, ProgramTimeline, compileProgram, EndpointPlaybackSession, signControl } from '../../../dist/src/index.js';
import { SignalPlaybackInbox, createSignalControl } from '../src/playback.mjs';
import { fixture, scope } from './helpers.mjs';

import { playbackFixture } from './playback-helper.mjs';

for (const platform of ['android', 'ios']) {
  test(`${platform}: real Signal-delivered manifest and private lease drive an owned playback session`, async t => {
    const p = await playbackFixture(platform); t.after(() => p.close());
    const control = await p.control();
    assert.equal(JSON.stringify(control).includes('maxLinearGain'), false);
    assert.equal(JSON.stringify(p.manifestWire).includes(p.descriptor.manifest.attachmentKeyHex), false);
    await p.session.join(control); assert.equal((await p.session.pump()).status, 'scheduled');
    assert.equal(p.views[0].samples[0], 0.5); assert.equal(p.views[0].gainCeiling, 0.5);
    const counters = p.f.bob.vault.read('control-checkpoints').value;
    assert.equal(counters[0].sequence, 1);
  });
  test(`${platform}: revoked sender membership stops even cached media and signed emergency authority`, async t => {
    const p = await playbackFixture(platform); t.after(() => p.close());
    await p.session.join(await p.control()); await p.session.pump();
    const emergency = await p.control(2, 'emergency-stop'); await p.f.rotate(p.f.alice);
    await assert.rejects(p.options.controls.accept(emergency, p.f.now), /IDENTITY_CHANGED/);
    await assert.rejects(p.session.pump(), /IDENTITY_CHANGED/); assert.equal(p.session.snapshot().phase, 'stopped');
  });
  test(`${platform}: a validly signed outer control cannot substitute the encrypted inner header`, async t => {
    const p = await playbackFixture(platform); t.after(() => p.close());
    const control = await p.control();
    const substituted = await signControl({ ...control.body, expiresAtMs: control.body.expiresAtMs + 1 }, await p.f.alice.channel.localControlKey());
    await assert.rejects(p.session.join(substituted), /HEADER_MISMATCH/);
    assert.equal(p.views.length, 0); assert.equal(p.session.snapshot().phase, 'stopped');
  });
}
test('manifest inbox rejects wrong private context and expired delivery instead of caching a key', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const inbox = new SignalPlaybackInbox({ channel: f.bob.channel, sender: f.aliceId, nowUnixMs: () => f.now }); t.after(() => inbox.close());
  const context = { tenantId: scope.tenantId, application: scope.application, parentMessageId: 'correct-parent' };
  const media = await packageRendition({ sampleRate: 8000, channels: 1, samples: new Float32Array(8000) }, 1, context, 'test.wav');
  const descriptor = { assetId: 'asset', context, manifest: media.privateManifest, sampleRate: 8000, channels: 1, frames: 8000, authorizationValidUntilMs: f.now + 1000 };
  const wire = await f.alice.channel.seal(f.bobId, 'manifest', descriptor, f.messageOptions('wrong-parent'));
  await assert.rejects(inbox.acceptManifest(wire), /BINDING_MISMATCH/);
  await assert.rejects(inbox.resolver.resolve('asset', scope, new AbortController().signal), /UNAVAILABLE/);
  const expired = await f.alice.channel.seal(f.bobId, 'manifest', descriptor,
    { messageId: context.parentMessageId, expiresAtMs: f.now + 100 });
  f.setNow(f.now + 101); await assert.rejects(inbox.acceptManifest(expired), /EXPIRED/);
});
