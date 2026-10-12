import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DeviceRegistry, createControlSigningKey, signDeviceEvent } from '../../../dist/src/index.js';
import { EncryptedFileVault } from '../src/vault.mjs';
import { initializeSignalIdentity, SignalParentChannel } from '../src/channel.mjs';
export const scope = { tenantId: 'tenant', application: 'distributed-radio', sessionId: 'session' };
export const ALL = ['manifest', 'control', 'ack'];
export async function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), 'dae-signal-'));
  let now = 1_800_000_000_000;
  const entries = [];
  for (const name of ['alice', 'bob', 'eve']) {
    const directory = join(rootDir, name); mkdirSync(directory, { mode: 0o700 });
    const key = randomBytes(32);
    const options = { directory, key, binding: { scope, identityId: name, deviceId: 'phone' } };
    const vault = new EncryptedFileVault(options);
    const descriptor = await initializeSignalIdentity(vault, { scope, identityId: name, deviceId: 'phone', nowMs: now });
    const root = await createControlSigningKey();
    const identityScope = { tenantId: scope.tenantId, application: scope.application, identityId: name };
    const registry = new DeviceRegistry(identityScope, root.publicKey);
    await registry.apply(await signDeviceEvent({ scope: identityScope, sequence: 1,
      precedingStateHashHex: await registry.stateHash(), action: 'enroll', deviceId: 'phone', replacement: descriptor.device }, root.privateKey));
    const channel = new SignalParentChannel({ vault, scope, localRegistry: registry, nowUnixMs: () => now });
    entries.push({ name, vault, key, options, descriptor, root, registry, channel, identityScope });
  }
  const [alice, bob, eve] = entries;
  function authorize(a, b, roles = ALL) { return a.channel.authorizePeer(b.registry, 'phone', { send: roles, receive: roles, expiresAtMs: now + 300_000 }); }
  const bobId = authorize(alice, bob), aliceId = authorize(bob, alice);
  async function connect() { await alice.channel.connect(bobId, await bob.channel.publicBundle()); }
  function expiry() { return now + 10_000; }
  function messageOptions(messageId = 'message') { return { messageId, expiresAtMs: expiry() }; }
  async function rotate(who) {
    const signing = randomBytes(32).toString('hex'), agreement = randomBytes(32).toString('hex');
    await who.registry.apply(await signDeviceEvent({ scope: who.identityScope, sequence: 2,
      precedingStateHashHex: await who.registry.stateHash(), action: 'rotate', deviceId: 'phone',
      replacement: { id: 'phone', generation: 2,
        signing: { id: 'rotated-sign', algorithm: 'ALG-ED25519', publicKeyHex: signing },
        agreement: { id: 'rotated-agree', algorithm: 'ALG-X25519', publicKeyHex: agreement } } }, who.root.privateKey));
  }
  return { alice, bob, eve, connect, authorize, bobId, aliceId, messageOptions, expiry, rotate,
    get now() { return now; }, setNow(value) { now = value; },
    close() { for (const entry of entries) { entry.channel.close(); entry.vault.close(); entry.key.fill(0); } rmSync(rootDir, { recursive: true, force: true }); }
  };
}
