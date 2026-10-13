import type { Scope, DeviceRegistry, DeviceRecord, ControlBody, SignedControl, ControlVerifier,
  ProgramTimeline, CiphertextChunkTransport, ProgramPlayerOptions, PlaybackSessionOptions, EndpointCryptoKey } from '../../../dist/src/index.js';
export type ParentKind = 'manifest' | 'control' | 'ack';
export interface VaultRow<T = unknown> { revision: number; value: T }
export interface EndpointVault {
  read<T = unknown>(name: string): VaultRow<T> | undefined;
  compareAndSet(name: string, expectedRevision: number | undefined, value: unknown): boolean;
}
export class EncryptedFileVault implements EndpointVault {
  constructor(options: { directory: string; filename?: string; key: Uint8Array; binding: unknown; minimumRevision?: number });
  readonly revision: number;
  read<T = unknown>(name: string): VaultRow<T> | undefined;
  compareAndSet(name: string, expectedRevision: number | undefined, value: unknown): boolean;
  close(): void;
}
export class EncryptedCheckpointStore {
  constructor(vault: EndpointVault);
  read(scopeKey: string): { epoch: number; sequence: number } | undefined;
  compareAndSet(scopeKey: string, expected: { epoch: number; sequence: number } | undefined, next: { epoch: number; sequence: number }): boolean;
}
export interface SignalIdentityDescriptor { scope: Scope; identityId: string; device: Omit<DeviceRecord, 'status'>; address: string }
export interface SignalWire { protocol: 'signal-libsignal-0.105.0'; from: string; to: string; messageType: 2 | 3; ciphertext: string }
export interface ParentMessage { domain: 'DAE-SIGNAL-PARENT-v1'; protocol: 'signal-libsignal-0.105.0'; scope: Scope;
  from: string; to: string; kind: ParentKind; messageId: string; issuedAtMs: number; expiresAtMs: number; payload: unknown }
export interface SignalPublicBundle { body: { protocol: 'signal-libsignal-0.105.0'; scope: Scope; address: string;
  issuedAtMs: number; expiresAtMs: number; registrationId: number; deviceId: number; identityKey: string;
  preKeyId: number; preKey: string; signedPreKeyId: number; signedPreKey: string; signedPreKeySignature: string;
  kyberPreKeyId: number; kyberPreKey: string; kyberPreKeySignature: string }; signature: string }
export function initializeSignalIdentity(vault: EndpointVault, options: { scope: Scope; identityId: string;
  deviceId: string; generation?: number; nowMs: number }): Promise<SignalIdentityDescriptor>;
export function signalIdentityDescriptor(vault: EndpointVault): SignalIdentityDescriptor;
export type DeliveryPacket =
  | { deliveryId: string; recordType: 'signal'; record: SignalWire; expiresAtMs: number }
  | { deliveryId: string; recordType: 'control'; record: SignedControl; expiresAtMs: number };
export interface OutboundDelivery { recipient: string; kind: ParentKind; status: 'pending' | 'sent'; packet: DeliveryPacket }
export interface InboxReceipt { messageKey: string; sender: string; kind: ParentKind; messageId: string; expiresAtMs: number }
export interface PendingMessage extends InboxReceipt { status: 'pending'; message: ParentMessage }
export interface CompletedMessage extends InboxReceipt { status: 'completed' }
export type InboxMessage = PendingMessage | CompletedMessage;
export class SignalParentChannel {
  constructor(options: { vault: EndpointVault; scope: Scope; localRegistry: DeviceRegistry; nowUnixMs: () => number });
  readonly publicIdentity: SignalIdentityDescriptor;
  authorizePeer(registry: DeviceRegistry, deviceId: string, permission: { send: ParentKind[]; receive: ParentKind[]; expiresAtMs: number }): string;
  revokePeer(address: string): void;
  requirePeer(address: string, kind: ParentKind, direction?: 'send' | 'receive'): { identityId: string; device: DeviceRecord; expiresAtMs: number };
  controlPublicKey(address: string): Promise<EndpointCryptoKey>;
  localControlKey(): Promise<EndpointCryptoKey>;
  publicBundle(): Promise<SignalPublicBundle>;
  connect(address: string, bundle: SignalPublicBundle): Promise<void>;
  seal(address: string, kind: ParentKind, payload: unknown, options: { messageId: string; expiresAtMs: number }): Promise<SignalWire>;
  receive(wire: SignalWire, expectedKind?: ParentKind): Promise<ParentMessage>;
  queueMessage(address: string, kind: ParentKind, payload: unknown,
    options: { messageId: string; expiresAtMs: number }): Promise<OutboundDelivery>;
  queueControl(address: string,
    fields: { epoch: number; sequence: number; issuedAtMs: number; expiresAtMs: number; action: 'lease' | 'emergency-stop' },
    payload: unknown, options: { messageId: string }): Promise<OutboundDelivery>;
  receiveQueued(wire: SignalWire, expectedKind?: ParentKind): Promise<InboxMessage>;
  pendingDeliveries(address: string): Promise<OutboundDelivery[]>;
  markDeliverySent(deliveryId: string): Promise<OutboundDelivery>;
  pendingMessages(address: string): Promise<PendingMessage[]>;
  completeMessage(messageKey: string): Promise<CompletedMessage>;
  sweepJournal(): Promise<void>;
  close(): void;
}
export function createSignalControl(channel: SignalParentChannel, recipient: string,
  fields: { epoch: number; sequence: number; issuedAtMs: number; expiresAtMs: number; action: 'lease' | 'emergency-stop' },
  payload: unknown): Promise<SignedControl>;
export class SignalPlaybackInbox {
  constructor(options: { channel: SignalParentChannel; sender: string; nowUnixMs: () => number });
  createVerifier(vault: EndpointVault): Promise<ControlVerifier>;
  sessionOptions(options: { vault: EndpointVault; timeline: ProgramTimeline; transport: CiphertextChunkTransport;
    authorizePlayback: ProgramPlayerOptions['authorizePlayback']; consentedGainCeiling: number }): Promise<PlaybackSessionOptions>;
  acceptManifest(wire: SignalWire): Promise<{ assetId: string; expiresAtMs: number }>;
  readonly resolver: ProgramPlayerOptions['resolver'];
  readonly decodeControlPayload: (body: ControlBody) => Promise<unknown>;
  close(): void;
}
export const PROTOCOL: 'signal-libsignal-0.105.0';
