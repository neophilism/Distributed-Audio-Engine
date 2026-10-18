import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceRouteProfiles } from '../src/device-profiles.js';
const route = { endpointId: 'endpoint', routeId: 'route', outputId: 'output', kind: 'bluetooth-speaker' as const, generation: 1 };
test('paired devices and labels are never native output proof', () => {
  const p = new DeviceRouteProfiles(() => {});
  for (const origin of ['paired-device', 'display-name'] as const) {
    assert.throws(() => p.observe({ origin, route, observedAtMs: 100, playbackSupported: true, capabilities: ['pcm-output'] }), /ACTIVE_NATIVE_ROUTE_REQUIRED/);
  }
  assert.equal(p.snapshot().state, 'unavailable');
});
test('active route changes invalidate evidence without implying acoustic speaker verification', () => {
  let calls = 0; const p = new DeviceRouteProfiles(() => { calls++; });
  const first = p.observe({ origin: 'native-active-output', route, observedAtMs: 100, playbackSupported: true, capabilities: ['pcm-output'] });
  assert.equal(first.speakerProven, false); p.requireCurrent(route, 1);
  const second = { ...route, routeId: 'headset', kind: 'headphones' as const, generation: 2 };
  p.observe({ origin: 'native-active-output', route: second, observedAtMs: 101, playbackSupported: true, capabilities: [] });
  assert.throws(() => p.requireCurrent(route, 1), /ROUTE_PROFILE_CHANGED/);
  p.interrupt(); assert.throws(() => p.requireCurrent(second, 2), /ROUTE_PROFILE_CHANGED/);
  assert.equal(calls, 3);
  assert.throws(() => p.observe({ origin: 'native-active-output', route: second, observedAtMs: 102, playbackSupported: true, capabilities: [] }));
});
test('invalid capabilities fail closed', () => {
  const p = new DeviceRouteProfiles(() => {});
  assert.throws(() => p.observe({ origin: 'native-active-output', route, observedAtMs: 0, playbackSupported: true, capabilities: ['pcm-output','pcm-output'] }), /INVALID_ROUTE_CAPABILITIES/);
});
