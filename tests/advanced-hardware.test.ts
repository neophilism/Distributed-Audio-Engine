import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdvancedHardwarePositionAdapter } from '../src/advanced-hardware.js';
const valid = {
  origin: 'trusted-native-coordinate' as const, hardware: 'uwb' as const,
  objectId: 'speaker', trackerId: 'tracker', sequence: 1, atMs: 100,
  x: 1, y: 2, z: 3, uncertaintyMeters: 0.2, confidence: 0.95
};
const policy = { maxAgeMs: 100, maxUncertaintyMeters: 1, minConfidence: 0.9 };
test('trusted calibrated coordinate can update only its bound physical output', () => {
  const adapter = new AdvancedHardwarePositionAdapter(policy, ['uwb']);
  adapter.placements.bindTracked('speaker', 'tracker');
  adapter.observe(valid, 110);
  assert.deepEqual(adapter.placements.positionAt('speaker', 110), {
    position: { x: 1, y: 2, z: 3 }, state: 'tracked'
  });
  assert.throws(() => adapter.observe({ ...valid, objectId: 'other', sequence: 2 }, 110), /TRACKER_NOT_BOUND/);
  assert.throws(() => adapter.observe({ ...valid, sequence: 1 }, 110), /TRACKING_REPLAY_OR_ROLLBACK/);
  assert.equal(adapter.placements.positionAt('speaker', 301), null);
});
test('BLE presence, unsupported hardware, stale and low-confidence data cannot invent coordinates', () => {
  const adapter = new AdvancedHardwarePositionAdapter(policy, ['uwb']);
  adapter.placements.bindTracked('speaker', 'tracker');
  assert.throws(() => adapter.observe({ ...valid, origin: 'ble-presence' }, 110), /HARDWARE_COORDINATE_UNVERIFIED/);
  assert.throws(() => adapter.observe({ ...valid, hardware: 'ble' }, 110), /HARDWARE_COORDINATE_UNVERIFIED/);
  assert.throws(() => adapter.observe({ ...valid, atMs: 1 }, 110), /TRACKING_INCONCLUSIVE/);
  assert.throws(() => adapter.observe({ ...valid, confidence: 0.2 }, 110), /TRACKING_INCONCLUSIVE/);
  assert.equal(adapter.placements.positionAt('speaker', 110), null);
});
