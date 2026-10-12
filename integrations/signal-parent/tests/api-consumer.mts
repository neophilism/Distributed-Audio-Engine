import { SignalParentChannel, SignalPlaybackInbox, EncryptedFileVault, createSignalControl } from '../src/index.mjs';
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
