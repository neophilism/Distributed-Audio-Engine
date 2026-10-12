import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const core = createRequire(import.meta.url)(process.env.DAE_TEST_ADDON);
const ok = code => assert.equal(code, 0, 'native test bridge rejected request');

// Real production C queue with synthetic route/clock. Not an OS audio driver.
export class KernelBridge {
  handle = core.create(8000, 2); generation = 0; next = 0n; ids = new Map(); rawViews = []; listener;
  constructor(now) { this.now = now; }
  subscribe(fn) { this.listener = fn; return () => { this.listener = undefined; }; }
  activate(generation) {
    ok(core.activate(this.handle, BigInt(generation), this.now())); this.generation = generation;
    this.listener({ type: 'route-active', route: { endpointId: 'endpoint', routeId: 'route', outputId: 'output',
      kind: 'unknown', generation }, sampleRate: 8000, maxChannels: 2 });
  }
  enqueue(r) {
    const id = ++this.next;
    ok(core.enqueue(this.handle, id, BigInt(r.routeGeneration), r.samples, this.now(),
      r.startAtMonotonicMs ?? r.startAtHostTimeMs, r.fadeStartMonotonicMs ?? r.fadeStartHostTimeMs,
      r.stopAtMonotonicMs ?? r.stopAtHostTimeMs, r.gainCeiling));
    this.ids.set(r.id, id); this.rawViews.push(r.samples);
  }
  updateEnvelope(id, gain, fade, stop) {
    const token = this.ids.get(id); if (token) ok(core.update(this.handle, BigInt(this.generation), token, gain, fade, stop));
  }
  cancel(id) {
    const token = this.ids.get(id); if (token) { ok(core.cancel(this.handle, BigInt(this.generation), token)); this.ids.delete(id); }
    this.drain();
  }
  cancelAll() { ok(core.cancelAll(this.handle)); this.ids.clear(); }
  drain() {
    const done = new Set(core.drain(this.handle));
    for (const [id, token] of this.ids) if (done.has(token)) { this.ids.delete(id); this.listener?.({ type: 'completed', id }); }
  }
  render(at, frames = 80) {
    const result = core.render(this.handle, BigInt(this.generation), at, frames); this.drain(); ok(result.status); return result.samples;
  }
  get samplesQueued() { return core.inspect(this.handle).samples; }
  close() { core.close(this.handle); }
}
