import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutputLifecycle } from '../src/output-lifecycle.js';
import { PlacementRegistry } from '../src/placement.js';

test('1,000 output changes invalidate prior route evidence without false acoustic proof', () => {
  let invalidations = 0;
  const lifecycle = new OutputLifecycle(() => { invalidations++; });
  for (let generation = 1; generation <= 1000; generation++) {
    const current = {
      endpointId: 'endpoint', routeId: 'route-' + generation,
      outputId: 'speaker', kind: 'bluetooth-speaker' as const, generation
    };
    lifecycle.active(current, true);
    lifecycle.requireCurrent(current);
    assert.equal(lifecycle.snapshot().state, 'active');
    if (generation > 1) {
      const old = { ...current, routeId: 'route-' + (generation - 1), generation: generation - 1 };
      assert.throws(() => lifecycle.requireCurrent(old), /OUTPUT_ROUTE_CHANGED/);
    }
  }
  assert.equal(invalidations, 1000);
  lifecycle.disconnect();
  assert.equal(lifecycle.snapshot().state, 'unavailable');
  assert.equal(invalidations, 1001);
});

test('1,000 independently tracked objects preserve identity, replay and staleness limits', () => {
  const registry = new PlacementRegistry({ maxAgeMs: 100, maxUncertaintyMeters: 1, minConfidence: 0.9 });
  for (let i = 0; i < 1000; i++) {
    const objectId = 'object-' + i, trackerId = 'tracker-' + i;
    registry.bindTracked(objectId, trackerId);
    const observation = {
      objectId, trackerId, sequence: 1,
      atMs: 1000, position: { x: i, y: 0, z: 0 },
      uncertaintyMeters: 0.1, confidence: 0.99,
      method: 'validated-coordinate' as const
    };
    registry.observe(observation, 1001);
    assert.deepEqual(registry.positionAt(objectId, 1001), {
      position: { x: i, y: 0, z: 0 }, state: 'tracked'
    });
    assert.throws(() => registry.observe(observation, 1001), /TRACKING_REPLAY_OR_ROLLBACK/);
  }
  assert.equal(registry.positionAt('object-0', 1200), null);
  assert.equal(registry.positionAt('object-999', 1200), null);
  registry.setFixed('fixed-speaker', { x: 1, y: 2, z: 3 }, 1000);
  assert.deepEqual(registry.positionAt('fixed-speaker', 1200), {
    position: { x: 1, y: 2, z: 3 }, state: 'fixed'
  });
});
