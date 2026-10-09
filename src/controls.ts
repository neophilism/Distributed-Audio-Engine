import { canonicalJson, identifier, integer, invariant } from './validation.js';
import type { Scope } from './contracts.js';
import type { EndpointCryptoKey, EndpointCryptoKeyPair } from './crypto-types.js';
const encoder = new TextEncoder();
export interface ControlBody {
  version: '1.0.0';
  scope: Scope;
  keyId: string;
  algorithm: 'ALG-ED25519';
  epoch: number;
  sequence: number;
  issuedAtMs: number;
  expiresAtMs: number;
  action: string;
  /** Ciphertext already protected by an authenticated E2EE control channel. */
  payloadCiphertextBase64: string;
}
export interface SignedControl { body: ControlBody; signatureHex: string }
export interface ControlCheckpoint { epoch: number; sequence: number }
/** Production implementations must atomically persist this compare-and-set. */
export interface CheckpointStore {
  read(scopeKey: string): ControlCheckpoint | undefined;
  compareAndSet(scopeKey: string, expected: ControlCheckpoint | undefined, next: ControlCheckpoint): boolean;
}
export class MemoryCheckpointStore implements CheckpointStore {
  private readonly values = new Map<string, ControlCheckpoint>();
  read(key: string): ControlCheckpoint | undefined {
    const value = this.values.get(key); return value ? { ...value } : undefined;
  }
  compareAndSet(key: string, expected: ControlCheckpoint | undefined, next: ControlCheckpoint): boolean {
    const current = this.values.get(key);
    if (canonicalJson(current ?? null) !== canonicalJson(expected ?? null)) return false;
    this.values.set(key, { ...next }); return true;
  }
}
function exactKeys(value: object, keys: string[]): void {
  invariant(canonicalJson(Object.keys(value).sort()) === canonicalJson(keys.sort()), 'UNKNOWN_CONTROL_FIELDS');
}
function validateBody(body: ControlBody): void {
  invariant(body && typeof body === 'object' && body.scope && typeof body.scope === 'object', 'INVALID_CONTROL');
  exactKeys(body, ['version','scope','keyId','algorithm','epoch','sequence','issuedAtMs','expiresAtMs','action','payloadCiphertextBase64']);
  exactKeys(body.scope, ['tenantId','application','sessionId']);
  identifier(body.scope.tenantId); identifier(body.scope.sessionId); identifier(body.keyId); identifier(body.action);
  invariant(body.scope.application === 'scenesignal' || body.scope.application === 'distributed-radio', 'INVALID_APPLICATION');
  invariant(body.version === '1.0.0' && body.algorithm === 'ALG-ED25519', 'UNSUPPORTED_CONTROL_VERSION');
  integer(body.epoch, 1); integer(body.sequence, 1); integer(body.issuedAtMs); integer(body.expiresAtMs);
  invariant(body.expiresAtMs > body.issuedAtMs, 'INVALID_CONTROL_EXPIRY');
  invariant(typeof body.payloadCiphertextBase64 === 'string' && body.payloadCiphertextBase64.length <= 65536 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.payloadCiphertextBase64), 'INVALID_CONTROL_PAYLOAD');
}
function controlBytes(body: ControlBody): Uint8Array<ArrayBuffer> {
  return encoder.encode(canonicalJson({ domain: 'DAE-CONTROL-v1', body }));
}
export async function createControlSigningKey(): Promise<EndpointCryptoKeyPair> {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign','verify']);
  invariant('publicKey' in keys && 'privateKey' in keys, 'INVALID_GENERATED_KEY_PAIR'); return keys;
}
export async function signControl(body: ControlBody, privateKey: EndpointCryptoKey): Promise<SignedControl> {
  const snapshot = structuredClone(body); validateBody(snapshot);
  invariant(privateKey.type === 'private' && privateKey.algorithm.name === 'Ed25519', 'INVALID_SIGNING_KEY');
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', privateKey, controlBytes(snapshot)));
  return { body: snapshot, signatureHex: Array.from(signature, b => b.toString(16).padStart(2,'0')).join('') };
}
/** Verifies integrity/authority only. Never decrypt or execute a payload here. */
export class ControlVerifier {
  private readonly scope: Scope;
  private readonly signers: ReadonlyMap<string, EndpointCryptoKey>;
  private readonly actions: ReadonlySet<string>;
  constructor(scope: Scope, signers: ReadonlyMap<string, EndpointCryptoKey>, actions: ReadonlySet<string>, private readonly checkpoints: CheckpointStore, private readonly maxLifetimeMs = 60_000) {
    this.scope = structuredClone(scope); this.signers = new Map(signers); this.actions = new Set(actions);
    identifier(scope.tenantId); identifier(scope.sessionId); integer(maxLifetimeMs, 1, 300_000);
    invariant(scope.application === 'scenesignal' || scope.application === 'distributed-radio', 'INVALID_APPLICATION');
  }
  matchesScope(scope: Scope): boolean { return canonicalJson(scope) === canonicalJson(this.scope); }
  async accept(control: SignedControl, nowMs: number): Promise<ControlBody> {
    integer(nowMs);
    const envelope = structuredClone(control);
    exactKeys(envelope, ['body','signatureHex']); validateBody(envelope.body);
    const body = envelope.body;
    invariant(canonicalJson(body.scope) === canonicalJson(this.scope), 'CONTROL_SCOPE_MISMATCH');
    invariant(this.actions.has(body.action), 'ACTION_NOT_AUTHORIZED');
    invariant(body.issuedAtMs <= nowMs && body.expiresAtMs > nowMs && body.expiresAtMs - body.issuedAtMs <= this.maxLifetimeMs, 'CONTROL_EXPIRED_OR_FUTURE');
    const key = this.signers.get(body.keyId);
    invariant(key && key.type === 'public' && key.algorithm.name === 'Ed25519', 'UNKNOWN_CONTROL_SIGNER');
    invariant(typeof envelope.signatureHex === 'string' && /^[0-9a-f]{128}$/.test(envelope.signatureHex), 'INVALID_SIGNATURE');
    const signature = Uint8Array.from(envelope.signatureHex.match(/.{2}/g)!.map(x => parseInt(x,16)));
    invariant(await crypto.subtle.verify('Ed25519', key, signature, controlBytes(body)), 'CONTROL_AUTHENTICATION_FAILED');
    // No await between replay-state read and its atomic compare-and-set.
    const scopeKey = canonicalJson(this.scope);
    const previous = this.checkpoints.read(scopeKey);
    if (previous) {
      invariant(body.epoch >= previous.epoch, 'CONTROL_EPOCH_ROLLBACK');
      invariant(body.epoch === previous.epoch ? body.sequence === previous.sequence + 1 : body.sequence === 1, 'CONTROL_REPLAY_OR_GAP');
    } else invariant(body.sequence === 1, 'CONTROL_INITIAL_GAP');
    invariant(this.checkpoints.compareAndSet(scopeKey, previous, {epoch: body.epoch, sequence: body.sequence}), 'CONTROL_CHECKPOINT_CONFLICT');
    return body;
  }
}
