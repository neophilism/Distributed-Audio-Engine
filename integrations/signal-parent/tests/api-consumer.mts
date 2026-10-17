import { SignalParentChannel, SignalRelayEndpoint, SignalPlaybackInbox, EncryptedFileVault, createSignalControl } from '../src/index.mjs';
import { EndpointPlaybackSession } from '../../../dist/src/index.js';
import type { PlaybackSessionOptions, AndroidAudioBridge, Scope, DeviceRegistry } from '../../../dist/src/index.js';
declare const vault: EncryptedFileVault, scope: Scope, registry: DeviceRegistry, sender: string, options: PlaybackSessionOptions, bridge: AndroidAudioBridge;
const channel = new SignalParentChannel({ vault, scope, localRegistry: registry, nowUnixMs: Date.now });
const inbox = new SignalPlaybackInbox({ channel, sender, nowUnixMs: Date.now });
const configured: PlaybackSessionOptions = await inbox.sessionOptions({ vault, timeline: options.timeline,
  transport: options.transport, authorizePlayback: options.authorizePlayback, consentedGainCeiling: 0.5 });
void EndpointPlaybackSession.android({ ...configured, bridge, native: { nowMonotonicMs: () => 0 } });
void createSignalControl(channel, sender, { epoch: 1, sequence: 1, issuedAtMs: 0, expiresAtMs: 1000, action: 'lease' }, {});
// @ts-expect-error The API must reject implicit wildcard permissions.
channel.authorizePeer(registry, 'device', { send: ['*'], receive: [], expiresAtMs: 1000 });

const delivery = await channel.queueMessage(sender, 'manifest', { private: true }, { messageId: 'stable-id', expiresAtMs: 1000 });
if (delivery.packet.recordType === 'signal') {
  const received = await channel.receiveQueued(delivery.packet.record, 'manifest');
  if (received.status === 'pending') { void received.message.payload; await channel.completeMessage(received.messageKey); }
  else {
    // @ts-expect-error Completed tombstones must not expose private payloads.
    void received.message;
  }
}
void channel.queueControl(sender, { epoch: 1, sequence: 1, issuedAtMs: 0, expiresAtMs: 1000, action: 'lease' }, {}, { messageId: 'stable-control-id' });
void channel.pendingDeliveries(sender); void channel.pendingMessages(sender);
void channel.markDeliverySent('stable-id'); void channel.sweepJournal();
// @ts-expect-error Durable queue requires an explicit stable ID.
void channel.queueMessage(sender, 'ack', {}, { expiresAtMs: 1000 });

const durableInbox = new SignalPlaybackInbox({ channel, sender, nowUnixMs: Date.now, durable: true, vault });
void durableInbox.restoreManifests();
const clockVerifier = await durableInbox.createClockVerifier(vault);
void clockVerifier.matchesScope(scope);
void channel.queueControl(sender, { epoch: 1, sequence: 2, issuedAtMs: 0, expiresAtMs: 1000, action: 'clock-response' },
  { nonce: 'a'.repeat(64), receivedUnixMs: 0, sentUnixMs: 0, uncertaintyMs: 0.1 }, { messageId: 'clock-response' });
// @ts-expect-error Durable manifest recovery requires its encrypted application store.
new SignalPlaybackInbox({ channel, sender, nowUnixMs: Date.now, durable: true });
import type { CiphertextRelayClient } from '../../../services/ciphertext-relay/src/index.mjs';
declare const relay: CiphertextRelayClient;
const pump = new SignalRelayEndpoint({ channel, relay, nowUnixMs: Date.now });
void pump.flush(sender); void pump.pull(); pump.close();
void channel.receivePacket(delivery.packet, sender);

import { DurableSignalController } from '../src/index.mjs';
const issuer = new DurableSignalController({ vault, channel, nowUnixMs: Date.now });
void issuer.issue({ operationId: 'durable-emergency', recipient: sender, action: 'emergency-stop',
  payload: null, expiresAtMs: 1000 });
void issuer.issue({ operationId: 'durable-clock', recipient: sender, action: 'clock-response',
  expiresAtMs: 1000, payload: { nonce: 'a'.repeat(64), receivedUnixMs: 0, sentUnixMs: 0, uncertaintyMs: 0.1 } });
void issuer.issue({ operationId: 'wrong-clock', recipient: sender, action: 'clock-response', expiresAtMs: 1000,
  // @ts-expect-error A clock response must bind to the outstanding nonce.
  payload: { receivedUnixMs: 0, sentUnixMs: 0, uncertaintyMs: 0.1 } });
void issuer.resume('durable-emergency'); void issuer.pending();
void issuer.advanceEpoch(sender, issuer.streamState(sender).epoch); issuer.close();
// @ts-expect-error An emergency control cannot carry a replacement playback payload.
void issuer.issue({ operationId: 'wrong', recipient: sender, action: 'emergency-stop', payload: {}, expiresAtMs: 1000 });
