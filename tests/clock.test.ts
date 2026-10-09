import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ControlVerifier, createControlSigningKey, DisciplinedClock, MemoryCheckpointStore, signControl } from '../src/index.js';
import type { ClockResponse, ControlBody } from '../src/index.js';
const scope = { tenantId: 'tenant', application: 'distributed-radio' as const, sessionId: 'session' };
async function fixture() {
  const keys = await createControlSigningKey(); let mono = 0; let response: ClockResponse | undefined; let sequence = 0;
  const verifier = new ControlVerifier(scope, new Map([['key', keys.publicKey]]), new Set(['clock-response']), new MemoryCheckpointStore());
  const clock = new DisciplinedClock(scope, verifier, async () => response, () => mono);
  const base: Omit<ControlBody, 'sequence'> = { version: '1.0.0', scope, keyId: 'key', algorithm: 'ALG-ED25519', epoch: 1, issuedAtMs: 100000, expiresAtMs: 130000, action: 'clock-response', payloadCiphertextBase64: 'YWJjZA==' };
  async function sample(sentMono: number, delay = 20, remoteOffset = 100000, drift = 0) {
    mono = sentMono; const probe = clock.beginProbe(); mono += delay;
    response = { nonce: probe.nonce, receivedUnixMs: remoteOffset + (sentMono + delay / 2) * (1 + drift / 1000000), sentUnixMs: remoteOffset + (sentMono + delay / 2) * (1 + drift / 1000000), uncertaintyMs: 0.1 };
    await clock.accept(await signControl({ ...base, sequence: ++sequence }, keys.privateKey), 100000);
  }
  return { keys, clock, verifier, base, sample, setMono(value: number) { mono = value; }, setResponse(value: ClockResponse) { response = value; }, nextBody() { return { ...base, sequence: ++sequence }; } };
}
test('authenticated four-timestamp samples estimate shared time with conservative delay uncertainty', async () => {
  const f = await fixture(); assert.equal(f.clock.estimate().state, 'unavailable'); assert.throws(() => f.clock.nowUnixMs(), /NOT_READY/);
  await f.sample(0); await f.sample(1000, 10); await f.sample(2000, 20); const estimate = f.clock.estimate(); assert.equal(estimate.state, 'usable');
  if (estimate.state === 'usable') { assert.ok(estimate.lowerUnixMs <= 102020 && estimate.upperUnixMs >= 102020); assert.ok(estimate.uncertaintyMs < 7); assert.equal(estimate.assurance, 'network-clock-only'); }
  assert.equal(f.clock.nowUnixMs(), 102020); f.setMono(2500); assert.equal(f.clock.nowUnixMs(), 102500);
});
test('bounded clock drift remains inside the interval; a drift estimate never becomes acoustic proof', async () => {
  const f = await fixture(); await f.sample(0, 2, 100000, 100); await f.sample(3000, 2, 100000, 100); await f.sample(6000, 2, 100000, 100);
  f.setMono(7000); const result = f.clock.estimate(); assert.equal(result.state, 'usable');
  if (result.state === 'usable') { const actual = 100000 + 7000 * 1.0001; assert.ok(result.lowerUnixMs <= actual && result.upperUnixMs >= actual); assert.ok(Math.abs(result.driftEstimatePpm! - 100) < 0.001); }
});
test('stale, high-uncertainty, conflicting and impossible time samples fail without manufacturing ready time', async () => {
  const stale = await fixture(); for (const t of [0, 1000, 2000]) await stale.sample(t); stale.setMono(20000); assert.equal(stale.clock.estimate().state, 'unavailable'); assert.throws(() => stale.clock.nowUnixMs());
  const uncertain = await fixture(); for (const t of [0, 3000, 6000]) await uncertain.sample(t, 1000); assert.throws(() => uncertain.clock.nowUnixMs(50), /UNCERTAINTY/);
  const conflict = await fixture(); await conflict.sample(0); await assert.rejects(conflict.sample(1000, 10, 200000), /CONFLICT/); assert.equal(conflict.clock.estimate().state, 'unavailable');
  const impossible = await fixture(); const probe = impossible.clock.beginProbe(); impossible.setMono(10); impossible.setResponse({ nonce: probe.nonce, receivedUnixMs: 100000, sentUnixMs: 100100, uncertaintyMs: 0 });
  await assert.rejects(impossible.clock.accept(await signControl(impossible.nextBody(), impossible.keys.privateKey), 100000), /IMPOSSIBLE/);
});
test('forged controls and unmatched challenges never contribute clock samples', async () => {
  const f = await fixture(); const probe = f.clock.beginProbe(); f.setMono(10); f.setResponse({ nonce: probe.nonce, receivedUnixMs: 100005, sentUnixMs: 100005, uncertaintyMs: 0 });
  const body = f.nextBody(); const wrong = await createControlSigningKey(); await assert.rejects(f.clock.accept(await signControl(body, wrong.privateKey), 100000));
  f.setResponse({ nonce: '0'.repeat(64), receivedUnixMs: 100005, sentUnixMs: 100005, uncertaintyMs: 0 }); await assert.rejects(f.clock.accept(await signControl(body, f.keys.privateKey), 100000), /CHALLENGE/); assert.equal(f.clock.estimate().state, 'unavailable');
});
test('reset or a newer probe supersedes slow authenticated response decoding', async () => {
  const f = await fixture(); let release!: (value: ClockResponse) => void; let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); let mono = 0;
  const clock = new DisciplinedClock(scope, f.verifier, async () => { entered(); return new Promise<ClockResponse>(resolve => { release = resolve; }); }, () => mono);
  const probe = clock.beginProbe(); mono = 10; const promise = clock.accept(await signControl(f.nextBody(), f.keys.privateKey), 100000); await started;
  clock.reset(); release({ nonce: probe.nonce, receivedUnixMs: 100005, sentUnixMs: 100005, uncertaintyMs: 0 }); await assert.rejects(promise, /SUPERSEDED/); assert.equal(clock.estimate().state, 'unavailable');
});
test('monotonic input rollback rejects and large backwards corrections require rejoin', async () => {
  const f = await fixture(); for (const t of [0, 1000, 2000]) await f.sample(t, 20); f.clock.nowUnixMs(); f.setMono(2000); assert.throws(() => f.clock.estimate());
  const correction = await fixture(); for (const t of [0, 1000, 2000]) await correction.sample(t, 1000); correction.clock.nowUnixMs(1000);
  // After the old samples expire, a new trusted reference behind the prior returned time needs reset/rejoin.
  for (const t of [20000, 21000, 22000]) await correction.sample(t, 2, 70000); assert.throws(() => correction.clock.nowUnixMs(), /REJOIN_REQUIRED/);
});
