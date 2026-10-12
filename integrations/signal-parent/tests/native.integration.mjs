import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KernelBridge } from './kernel-bridge.mjs';
import { playbackFixture } from './playback-helper.mjs';
for (const platform of ['android', 'ios']) {
  test(`${platform}: Signal key exchange to encrypted manifest, authenticated lease and actual native PCM`, async t => {
    const p = await playbackFixture(platform, KernelBridge); t.after(() => p.close());
    await p.session.join(await p.control()); await p.session.pump();
    assert.ok(p.bridge.rawViews.every(view => view.every(n => n === 0)));
    assert.ok(p.bridge.samplesQueued > 0);
    const samples = p.bridge.render(p.nativeNow() + 50); assert.equal(samples[0], 0.25); assert.equal(samples[1], -0.25);
  });
  test(`${platform}: a Signal-delivered lease fades and stops in C without additional JS pumping`, async t => {
    const p = await playbackFixture(platform, KernelBridge); t.after(() => p.close());
    await p.session.join(await p.control()); await p.session.pump();
    assert.equal(p.bridge.render(p.nativeNow() + 450)[0], 0.125);
    assert.ok(p.bridge.render(p.nativeNow() + 500).every(n => n === 0)); assert.equal(p.bridge.samplesQueued, 0);
  });
  test(`${platform}: revoked rights remove native-owned PCM after actual encrypted delivery`, async t => {
    const p = await playbackFixture(platform, KernelBridge); t.after(() => p.close());
    await p.session.join(await p.control()); await p.session.pump(); p.deny();
    await assert.rejects(p.session.pump(), /RIGHTS_DENIED/);
    assert.equal(p.bridge.samplesQueued, 0); assert.ok(p.bridge.render(p.nativeNow() + 50).every(n => n === 0));
  });
  test(`${platform}: a currently authorized signed emergency stops the actual native queue`, async t => {
    const p = await playbackFixture(platform, KernelBridge); t.after(() => p.close());
    await p.session.join(await p.control()); await p.session.pump();
    await p.session.emergencyStop(await p.control(2, 'emergency-stop'));
    assert.equal(p.bridge.samplesQueued, 0); assert.ok(p.bridge.render(p.nativeNow() + 50).every(n => n === 0));
  });
  test(`${platform}: device-key rotation cancels cached native output rather than relying on the old pinned signer`, async t => {
    const p = await playbackFixture(platform, KernelBridge); t.after(() => p.close());
    await p.session.join(await p.control()); await p.session.pump(); await p.f.rotate(p.f.alice);
    await assert.rejects(p.session.pump(), /IDENTITY_CHANGED/);
    assert.equal(p.bridge.samplesQueued, 0); assert.ok(p.bridge.render(p.nativeNow() + 50).every(n => n === 0));
  });
}
