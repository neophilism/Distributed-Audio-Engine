import type { Scope } from './contracts.js';
import { ControlVerifier } from './controls.js';
import type { SignedControl } from './controls.js';
import type { ControlPayloadDecoder } from './safety.js';
import { validateChunkRequest } from './delivery.js';
import type { ChunkRequest, CiphertextChunkTransport } from './delivery.js';
import { canonicalJson, identifier, integer, invariant } from './validation.js';

export interface CoordinatorLease { coordinatorId: string; programId: string; expiresAtMs: number; term: number }
/** A primary endpoint authorizes a local route; local hosts never acquire media keys or playback authority. */
export class CoordinatorMonitor {
  readonly scope: Readonly<Scope>;
  private lease: CoordinatorLease | undefined;
  private lastNowMs = 0;
  private generation = 0;
  constructor(scope: Scope, private readonly programId: string, private readonly verifier: ControlVerifier, private readonly decode: ControlPayloadDecoder) {
    this.scope = Object.freeze({ ...scope }); identifier(scope.tenantId); identifier(scope.sessionId); identifier(programId);
    invariant(scope.application === 'scenesignal' || scope.application === 'distributed-radio', 'INVALID_APPLICATION');
    invariant(verifier.matchesScope(scope), 'COORDINATOR_SCOPE_MISMATCH');
  }
  private observe(nowMs: number): void { integer(nowMs, this.lastNowMs); this.lastNowMs = nowMs; }
  async accept(control: SignedControl, nowMs: number): Promise<void> {
    this.observe(nowMs); invariant(control.body.action === 'coordinator-lease', 'WRONG_CONTROL_ACTION'); const before = this.generation;
    const body = await this.verifier.accept(control, nowMs); invariant(before === this.generation, 'COORDINATOR_CONTROL_SUPERSEDED');
    invariant(canonicalJson(body.scope) === canonicalJson(this.scope), 'COORDINATOR_SCOPE_MISMATCH');
    const operation = ++this.generation; const payload = await this.decode(body);
    invariant(payload && typeof payload === 'object' && Object.keys(payload).sort().join(',') === 'coordinatorId,expiresAtMs,programId,term', 'INVALID_COORDINATOR_LEASE');
    const lease = structuredClone(payload) as CoordinatorLease; identifier(lease.coordinatorId); identifier(lease.programId); integer(lease.term, 1);
    invariant(lease.term === body.epoch, 'COORDINATOR_TERM_MISMATCH'); invariant(lease.programId === this.programId, 'COORDINATOR_PROGRAM_MISMATCH'); integer(lease.expiresAtMs, nowMs + 1, Math.min(body.expiresAtMs, nowMs + 30000));
    invariant(operation === this.generation && nowMs >= this.lastNowMs, 'COORDINATOR_CONTROL_SUPERSEDED'); this.lease = lease;
  }
  activeAt(nowMs: number): CoordinatorLease | undefined {
    this.observe(nowMs); if (this.lease && this.lease.expiresAtMs <= nowMs) this.lease = undefined;
    return this.lease ? { ...this.lease } : undefined;
  }
  disconnect(): void { this.generation++; this.lease = undefined; }
}
export interface CoordinatorTransportOptions { nowUnixMs: () => number; localTimeoutMs?: number; fallbackTimeoutMs?: number }
/** Registered opaque transports only: no URL/address is accepted from a control payload. */
export class CoordinatorChunkTransport implements CiphertextChunkTransport {
  private readonly locals: ReadonlyMap<string, CiphertextChunkTransport>;
  private readonly localTimeoutMs: number;
  private readonly fallbackTimeoutMs: number;
  private readonly nowUnixMs: () => number;
  private readonly requests = new Set<AbortController>();
  private closed = false;
  constructor(private readonly monitor: CoordinatorMonitor, locals: ReadonlyMap<string, CiphertextChunkTransport>, private readonly fallback: CiphertextChunkTransport, options: CoordinatorTransportOptions) {
    invariant(locals.size <= 128, 'TOO_MANY_COORDINATORS'); for (const id of locals.keys()) identifier(id); this.locals = new Map(locals);
    this.localTimeoutMs = options.localTimeoutMs ?? 500; this.fallbackTimeoutMs = options.fallbackTimeoutMs ?? 5000;
    integer(this.localTimeoutMs, 1, 3000); integer(this.fallbackTimeoutMs, 1, 10000); this.nowUnixMs = options.nowUnixMs;
  }
  private async attempt(transport: CiphertextChunkTransport, request: ChunkRequest, timeoutMs: number, outer: AbortSignal): Promise<Uint8Array> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; let canceled!: () => void;
    const cancellation = new Promise<never>((_resolve, reject) => { canceled = () => { controller.abort(); reject(new Error('DELIVERY_ABORTED')); }; outer.addEventListener('abort', canceled, { once: true }); if (outer.aborted) canceled(); });
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('CIPHERTEXT_DEADLINE_EXCEEDED')); }, timeoutMs); });
    try {
      const result = await Promise.race([transport.read({ ...request }, controller.signal), cancellation, timeout]);
      invariant(!outer.aborted && !this.closed, 'DELIVERY_ABORTED'); invariant(result.length === request.expectedBytes, 'CIPHERTEXT_LENGTH_MISMATCH'); return Uint8Array.from(result);
    } finally { if (timer) clearTimeout(timer); outer.removeEventListener('abort', canceled); controller.abort(); }
  }
  async read(request: ChunkRequest, signal?: AbortSignal): Promise<Uint8Array> {
    const local = { ...request }; validateChunkRequest(local);
    invariant(local.tenantId === this.monitor.scope.tenantId && local.application === this.monitor.scope.application, 'COORDINATOR_SCOPE_MISMATCH');
    invariant(!this.closed && !signal?.aborted && this.requests.size < 64, 'COORDINATOR_CLOSED_ABORTED_OR_BUSY');
    const controller = new AbortController(); this.requests.add(controller); const cancel = () => controller.abort(); signal?.addEventListener('abort', cancel, { once: true });
    try {
      const now = this.nowUnixMs(); const lease = this.monitor.activeAt(now); const transport = lease ? this.locals.get(lease.coordinatorId) : undefined;
      if (lease && transport) {
        try {
          const result = await this.attempt(transport, local, Math.min(this.localTimeoutMs, lease.expiresAtMs - now), controller.signal);
          const current = this.monitor.activeAt(this.nowUnixMs()); invariant(current && canonicalJson(current) === canonicalJson(lease), 'COORDINATOR_LEASE_CHANGED'); return result;
        } catch (error) { if (controller.signal.aborted || this.closed) throw error; }
      }
      invariant(!this.closed && !controller.signal.aborted, 'DELIVERY_ABORTED');
      return await this.attempt(this.fallback, local, this.fallbackTimeoutMs, controller.signal);
    } finally { signal?.removeEventListener('abort', cancel); this.requests.delete(controller); }
  }
  async invalidate(request: ChunkRequest): Promise<void> {
    validateChunkRequest(request); invariant(request.tenantId === this.monitor.scope.tenantId && request.application === this.monitor.scope.application, 'COORDINATOR_SCOPE_MISMATCH');
    const active = this.monitor.activeAt(this.nowUnixMs()); if (active) await this.locals.get(active.coordinatorId)?.invalidate?.(request);
    await this.fallback.invalidate?.(request);
  }
  close(): void { this.closed = true; for (const controller of this.requests) controller.abort(); }
}
