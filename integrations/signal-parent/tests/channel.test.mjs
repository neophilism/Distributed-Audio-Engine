import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';

test('real Signal prekey exchange and bidirectional ratchet deliver endpoint-only payloads', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const wire = await f.alice.channel.seal(f.bobId, 'manifest', { secret: 'private manifest key' }, f.messageOptions());
  assert.ok(!JSON.stringify(wire).includes('private manifest'));
  const received = await f.bob.channel.receive(wire, 'manifest');
  assert.equal(received.payload.secret, 'private manifest key');
  const reply = await f.bob.channel.seal(f.aliceId, 'ack', { received: received.messageId }, f.messageOptions('receipt'));
  assert.equal((await f.alice.channel.receive(reply, 'ack')).payload.received, 'message');
  const next = await f.alice.channel.seal(f.bobId, 'control', { expiresAtMs: f.expiry() }, f.messageOptions('next'));
  assert.equal(next.messageType, 2);
  assert.equal((await f.bob.channel.receive(next, 'control')).messageId, 'next');
  assert.equal(Object.keys(f.bob.vault.read('signal-state').value.preKeys).length, 0);
  assert.equal(Object.keys(f.bob.vault.read('signal-state').value.kyberKeys).length, 0);
});

test('relay identity replacement and bundle tampering fail without changing ratchet state', async t => {
  const f = await fixture(); t.after(() => f.close());
  const bundle = await f.bob.channel.publicBundle(), initial = f.alice.vault.revision;
  for (const mutate of [b => b.body.identityKey = f.eve.descriptor.device.agreement.publicKeyHex,
    b => b.body.registrationId++, b => b.body.scope.sessionId = 'other',
    b => delete b.body.kyberPreKey, b => b.signature = 'AA==', b => b.body.expiresAtMs = f.now]) {
    const changed = structuredClone(bundle); mutate(changed);
    await assert.rejects(f.alice.channel.connect(f.bobId, changed));
    assert.equal(f.alice.vault.revision, initial);
  }
  await f.alice.channel.connect(f.bobId, bundle);
  await assert.rejects(f.alice.channel.connect(f.bobId, bundle), /SESSION_ALREADY_EXISTS/);
});

test('ciphertext tampering never releases plaintext and does not consume a valid message', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const wire = await f.alice.channel.seal(f.bobId, 'manifest', { secret: 42 }, f.messageOptions());
  const before = f.bob.vault.revision;
  const changed = structuredClone(wire), bytes = Buffer.from(changed.ciphertext, 'base64');
  bytes[bytes.length - 4] ^= 0x80; changed.ciphertext = bytes.toString('base64');
  await assert.rejects(f.bob.channel.receive(changed), /AUTHENTICATION_OR_REPLAY/);
  assert.equal(f.bob.vault.revision, before);
  assert.equal((await f.bob.channel.receive(wire)).payload.secret, 42);
  await assert.rejects(f.bob.channel.receive(wire), /AUTHENTICATION_OR_REPLAY/);
});

test('out-of-order legitimate ratchet messages work; each is consumed only once', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  await f.bob.channel.receive(await f.alice.channel.seal(f.bobId, 'ack', {}, f.messageOptions('hello')));
  await f.alice.channel.receive(await f.bob.channel.seal(f.aliceId, 'ack', {}, f.messageOptions('ack')));
  const one = await f.alice.channel.seal(f.bobId, 'manifest', { number: 1 }, f.messageOptions('one'));
  const two = await f.alice.channel.seal(f.bobId, 'manifest', { number: 2 }, f.messageOptions('two'));
  assert.equal((await f.bob.channel.receive(two)).payload.number, 2);
  assert.equal((await f.bob.channel.receive(one)).payload.number, 1);
  await assert.rejects(f.bob.channel.receive(two), /AUTHENTICATION_OR_REPLAY/);
});

test('sender, recipient, protocol and kind substitutions cannot cross authorization boundaries', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const wire = await f.alice.channel.seal(f.bobId, 'manifest', {}, f.messageOptions());
  for (const mutate of [w => w.from = f.eve.descriptor.address, w => w.to = f.aliceId,
    w => w.protocol = 'plaintext', w => w.messageType = 8, w => w.extra = 1]) {
    const changed = structuredClone(wire); mutate(changed); await assert.rejects(f.bob.channel.receive(changed));
  }
  await assert.rejects(f.bob.channel.receive(wire, 'control'), /KIND_MISMATCH/);
  assert.equal((await f.bob.channel.receive(wire, 'manifest')).kind, 'manifest');
});

test('unapproved peers and unapproved content kinds have no default authority', async t => {
  const f = await fixture(); t.after(() => f.close());
  await assert.rejects(f.eve.channel.connect(f.bobId, await f.bob.channel.publicBundle()), /NOT_AUTHORIZED/);
  f.authorize(f.alice, f.bob, ['ack']); await f.connect();
  await assert.rejects(f.alice.channel.seal(f.bobId, 'manifest', {}, f.messageOptions()), /KIND_NOT_AUTHORIZED/);
});

test('root-verified key rotation immediately invalidates sending and receiving authority', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const wire = await f.alice.channel.seal(f.bobId, 'manifest', {}, f.messageOptions());
  await f.rotate(f.alice);
  await assert.rejects(f.bob.channel.receive(wire), /IDENTITY_CHANGED/);
  await assert.rejects(f.alice.channel.seal(f.bobId, 'ack', {}, f.messageOptions()), /IDENTITY_CHANGED/);
});

test('expiry and clock rollback fail closed, including while a signed bundle is being verified', async t => {
  const f = await fixture(); t.after(() => f.close());
  const bundle = await f.bob.channel.publicBundle();
  const pending = f.alice.channel.connect(f.bobId, bundle);
  const rejected = assert.rejects(pending, /EXPIRED|NOT_AUTHORIZED/);
  f.setNow(f.now + 300_001); await rejected;
  assert.equal(Object.keys(f.alice.vault.read('signal-state').value.sessions).length, 0);
  f.setNow(f.now - 1); assert.throws(() => f.alice.channel.requirePeer(f.bobId, 'ack'), /ROLLBACK/);
});

test('revocation and close supersede asynchronous key establishment without committing it', async t => {
  for (const action of ['revoke', 'close']) {
    const f = await fixture(); t.after(() => f.close());
    const bundle = await f.bob.channel.publicBundle(), before = f.alice.vault.revision;
    const pending = f.alice.channel.connect(f.bobId, bundle); const rejected = assert.rejects(pending, /SUPERSEDED/);
    if (action === 'revoke') f.alice.channel.revokePeer(f.bobId); else f.alice.channel.close();
    await rejected; assert.equal(f.alice.vault.revision, before);
  }
});

test('only one outstanding operation can consume a channel state', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const results = await Promise.allSettled([f.alice.channel.seal(f.bobId, 'ack', {}, f.messageOptions('one')),
    f.alice.channel.seal(f.bobId, 'ack', {}, f.messageOptions('two'))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(results.find(r => r.status === 'rejected').reason.message, /BUSY/);
  assert.equal((await f.bob.channel.receive(results.find(r => r.status === 'fulfilled').value)).kind, 'ack');
});

test('failed persistence withholds both outgoing ciphertext and incoming plaintext', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const save = f.alice.vault.compareAndSet.bind(f.alice.vault);
  f.alice.vault.compareAndSet = () => false;
  await assert.rejects(f.alice.channel.seal(f.bobId, 'ack', {}, f.messageOptions()), /STATE_CONFLICT/);
  f.alice.vault.compareAndSet = save;
  const wire = await f.alice.channel.seal(f.bobId, 'ack', { actual: true }, f.messageOptions());
  const saveBob = f.bob.vault.compareAndSet.bind(f.bob.vault);
  f.bob.vault.compareAndSet = () => { throw Error('simulated-disk-failure'); };
  await assert.rejects(f.bob.channel.receive(wire), /simulated-disk-failure/);
  f.bob.vault.compareAndSet = saveBob;
  assert.equal((await f.bob.channel.receive(wire)).payload.actual, true);
});

test('one-time KEM and EC keys cannot initialize a second sender session', async t => {
  const f = await fixture(); t.after(() => f.close());
  f.authorize(f.eve, f.bob); f.authorize(f.bob, f.eve);
  const bundle = await f.bob.channel.publicBundle();
  await f.alice.channel.connect(f.bobId, bundle); await f.eve.channel.connect(f.bobId, bundle);
  const first = await f.alice.channel.seal(f.bobId, 'ack', {}, f.messageOptions('first'));
  const reuse = await f.eve.channel.seal(f.bobId, 'ack', {}, f.messageOptions('reuse'));
  await f.bob.channel.receive(first); await assert.rejects(f.bob.channel.receive(reuse), /AUTHENTICATION_OR_REPLAY/);
});

test('oversized and accessor-bearing payloads fail before ratchet work', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect(); const before = f.alice.vault.revision;
  await assert.rejects(f.alice.channel.seal(f.bobId, 'manifest', { data: 'x'.repeat(30_000) }, f.messageOptions()), /MESSAGE_LIMIT/);
  let getter = false; const payload = {}; Object.defineProperty(payload, 'key', { enumerable: true, get() { getter = true; return 'value'; } });
  await assert.rejects(f.alice.channel.seal(f.bobId, 'manifest', payload, f.messageOptions()), /ACCESSOR/);
  assert.equal(getter, false); assert.equal(f.alice.vault.revision, before);
});

test('bounded malformed native ciphertext corpus rejects without releasing plaintext or changing state', async t => {
  const f = await fixture(); t.after(() => f.close()); await f.connect();
  const before = f.bob.vault.revision;
  let seed = 0x5a17;
  for (let trial = 0; trial < 128; trial++) {
    const bytes = new Uint8Array(1 + trial * 7);
    for (let i = 0; i < bytes.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; bytes[i] = seed >>> 24; }
    const wire = { protocol: 'signal-libsignal-0.105.0', from: f.aliceId, to: f.bobId, messageType: trial % 2 ? 2 : 3, ciphertext: Buffer.from(bytes).toString('base64') };
    await assert.rejects(f.bob.channel.receive(wire), /AUTHENTICATION_OR_REPLAY/);
  }
  assert.equal(f.bob.vault.revision, before);
});
