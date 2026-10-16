import type { Server } from 'node:https';
import type { Server as HttpServer } from 'node:http';
import type { SignalPublicBundle, SignalWire } from '../../../integrations/signal-parent/src/index.mjs';
import type { SignedControl, ChunkRequest, CiphertextChunkTransport } from '../../../dist/src/index.js';
export interface RelayGrant { tokenSha256: string; address: string; expiresAtMs: number; allowedRecipients: string[] }
export type RelayPacket = { deliveryId: string; expiresAtMs: number } &
  ({ recordType: 'signal'; record: SignalWire } | { recordType: 'control'; record: SignedControl });
export interface RelayReceipt { receiptId: string; status: 'stored' | 'acknowledged' }
export interface RelayMessage { receiptId: string; sender: string; packet: RelayPacket }
export interface ChunkUpload { application: 'scenesignal' | 'distributed-radio'; tenantId: string;
  storageObjectId: string; chunkIndex: number; ciphertextBase64: string; readers: string[]; expiresAtMs: number }
export class SqliteCiphertextMailbox {
  constructor(path: string, limits?: { maxPackets?: number; maxMailboxPackets?: number; maxBytes?: number; maxChunks?: number; maxChunkBytes?: number });
  enqueue(sender: string, recipient: string, packet: RelayPacket, now: number): RelayReceipt;
  poll(recipient: string, now: number): RelayMessage[];
  acknowledge(recipient: string, receipts: string[], now: number): void;
  publish(owner: string, bundle: SignalPublicBundle, now: number): { bundleId: string; status: 'taken' | 'available' };
  take(owner: string, now: number): SignalPublicBundle | null;
  putChunk(owner: string, input: ChunkUpload, now: number): { chunkId: string; status: 'stored' };
  readChunk(recipient: string, owner: string, request: ChunkRequest, now: number): Uint8Array;
  sweep(now: number): void;
  stats(now: number): { packets: number; pending: number; bytes: number; bundles: number; availableBundles: number; chunks: number; chunkBytes: number };
  close(): void;
}
export class RelayAccessPolicy {
  constructor(grants: RelayGrant[]);
  set(grant: RelayGrant): void;
  activeCount(now: number): number;
  revoke(tokenSha256: string): void;
}
export function createCiphertextRelay(options: { store: SqliteCiphertextMailbox; access: RelayAccessPolicy;
  key: string | Buffer; cert: string | Buffer; nowUnixMs?: () => number; requestDeadlineMs?: number; sweepIntervalMs?: number }): Server;
export function createRenderEdgeCiphertextRelay(options: { store: SqliteCiphertextMailbox; access: RelayAccessPolicy;
  publicOrigin: string; sourceCommit: string; nowUnixMs?: () => number; requestDeadlineMs?: number; sweepIntervalMs?: number }): HttpServer;
export class CiphertextRelayClient {
  constructor(options: { origin: string; token: string; ca?: string | Buffer; timeoutMs?: number });
  publishBundle(bundle: SignalPublicBundle, signal?: AbortSignal): Promise<{ bundleId: string; status: 'available' | 'taken' }>;
  takeBundle(recipient: string, signal?: AbortSignal): Promise<SignalPublicBundle | null>;
  send(recipient: string, packet: RelayPacket, signal?: AbortSignal): Promise<RelayReceipt>;
  poll(signal?: AbortSignal): Promise<RelayMessage[]>;
  acknowledge(receiptIds: string[], signal?: AbortSignal): Promise<void>;
  uploadChunk(chunk: ChunkUpload, signal?: AbortSignal): Promise<{ chunkId: string; status: 'stored' }>;
  chunksFrom(owner: string, scope: Pick<ChunkRequest, 'tenantId' | 'application'>): CiphertextChunkTransport;
  close(): void;
}
