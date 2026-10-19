import type { Scope, DeviceRegistry, DeviceRecord, ControlBody, SignedControl, ControlVerifier,
  ProgramTimeline, CiphertextChunkTransport, ProgramPlayerOptions, PlaybackSessionOptions, EndpointCryptoKey, ClockResponse, ClockProbe, DisciplinedClock, EncryptedLivePcmSegment } from '../../../dist/src/index.js';
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
export interface PendingMessage extends InboxReceipt { status: 'pending'; message: ParentMessage; packet?: DeliveryPacket }
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
    fields: { epoch: number; sequence: number; issuedAtMs: number; expiresAtMs: number; action: 'lease' | 'emergency-stop' | 'clock-response' },
    payload: unknown, options: { messageId: string }): Promise<OutboundDelivery>;
  receiveQueued(wire: SignalWire, expectedKind?: ParentKind): Promise<InboxMessage>;
  receivePacket(packet: DeliveryPacket, expectedSender: string): Promise<InboxMessage>;
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
  constructor(options: { channel: SignalParentChannel; sender: string; nowUnixMs: () => number } &
    ({ durable: true; vault: EndpointVault } | { durable?: false; vault?: EndpointVault }));
  createVerifier(vault: EndpointVault): Promise<ControlVerifier>;
  createClockVerifier(vault: EndpointVault): Promise<ControlVerifier>;
  sessionOptions(options: { vault: EndpointVault; timeline: ProgramTimeline; transport: CiphertextChunkTransport;
    authorizePlayback: ProgramPlayerOptions['authorizePlayback']; consentedGainCeiling: number }): Promise<PlaybackSessionOptions>;
  acceptManifest(wire: SignalWire): Promise<{ assetId: string; expiresAtMs: number }>;
  restoreManifests(): Promise<Array<{ assetId: string; expiresAtMs: number }>>;
  readonly resolver: ProgramPlayerOptions['resolver'];
  readonly decodeControlPayload: (body: ControlBody) => Promise<unknown>;
  close(): void;
}
/** The probe is encrypted on the existing authorized 'ack' channel. */
export function queueSignalClockProbe(options: {
  channel: SignalParentChannel; recipient: string; clock: DisciplinedClock;
  messageId: string; expiresAtMs: number;
}): Promise<{ probe: ClockProbe; delivery: OutboundDelivery }>;
/** Requires an already-authenticated pending inbox receipt and sampled reference uncertainty. */
export function respondSignalClockProbe(options: {
  channel: SignalParentChannel; controller: DurableSignalController; receipt: PendingMessage;
  receivedUnixMs: number; uncertaintyMs: number; nowUnixMs: () => number;
}): Promise<{ operationId: string; delivery: OutboundDelivery; reused: boolean }>;

/** Upload only ciphertext and opaque routing information to the existing relay. */
export interface EndpointLiveChunkRelay {
  uploadChunk(input: { application: Scope['application']; tenantId: string;
    storageObjectId: string; chunkIndex: number; ciphertextBase64: string;
    readers: string[]; expiresAtMs: number }, signal?: AbortSignal):
    Promise<{ chunkId: string; status: 'stored' }>;
}
/** Upload authenticated endpoint ciphertext before queueing its PRIVATE descriptor on Signal. */
export function queueEncryptedLiveSegment(options: {
  channel: SignalParentChannel; relay: EndpointLiveChunkRelay;
  recipient: string; segment: EncryptedLivePcmSegment;
  authorizationValidUntilMs: number; expiresAtMs: number;
  nowUnixMs: () => number; signal?: AbortSignal;
}): Promise<{ assetId: string; segmentIndex: number; uploadedChunks: number;
  delivery: OutboundDelivery }>;

export const PROTOCOL: 'signal-libsignal-0.105.0';

/** Trusted endpoint adapter: methods must honor AbortSignal and bounded work. */
export interface EndpointRelayTransport {
  send(recipient: string, packet: DeliveryPacket, signal?: AbortSignal): Promise<{ receiptId: string; status: 'stored' | 'acknowledged' }>;
  poll(signal?: AbortSignal): Promise<Array<{ receiptId: string; sender: string; packet: DeliveryPacket }>>;
  acknowledge(receiptIds: string[], signal?: AbortSignal): Promise<void>;
}
export class SignalRelayEndpoint {
  constructor(options: { channel: SignalParentChannel; relay: EndpointRelayTransport; nowUnixMs: () => number; timeoutMs?: number });
  flush(recipient: string, signal?: AbortSignal): Promise<{ sent: number }>;
  pull(signal?: AbortSignal): Promise<InboxMessage[]>;
  close(): void;
}

export type ControllerRequest = {
  operationId: string; recipient: string; expiresAtMs: number;
} & ({ action: 'lease'; payload: { expiresAtMs: number; stopAtMs: number; fadeMs: number; maxLinearGain: number } } |
  { action: 'emergency-stop'; payload: null } |
  { action: 'clock-response'; payload: ClockResponse });
export class DurableSignalController {
  constructor(options: { vault: EndpointVault; channel: SignalParentChannel; nowUnixMs: () => number });
  issue(request: ControllerRequest): Promise<OutboundDelivery>;
  resume(operationId: string): Promise<OutboundDelivery>;
  advanceEpoch(recipient: string, expectedEpoch: number): { epoch: number; sequence: number };
  streamState(recipient: string): { recipient: string; epoch: number; sequence: number; reservationId: string | null };
  pending(): Array<{ operationId: string; recipient: string; epoch: number; sequence: number;
    action: 'lease' | 'emergency-stop' | 'clock-response'; expiresAtMs: number; expired: boolean }>;
  close(): void;
}
