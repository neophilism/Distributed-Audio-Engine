import { canonicalJson, identifier, integer, invariant } from './validation.js';
import type { ApplicationScope } from './contracts.js';
import type { EndpointCryptoKey } from './crypto-types.js';
export type Permission = 'assets:write' | 'assets:read' | 'rights:write' | 'program:write' | 'control:send' | 'commerce:manage' | 'commerce:buy';
export interface IdentityScope { tenantId: string; application: ApplicationScope; identityId: string }
/** A trusted authentication adapter supplies this actor; this is a policy evaluator. */
export interface AuthenticatedActor extends IdentityScope { deviceId: string; expiresAtMs: number; permissions: readonly Permission[] }
export function requireAccess(actor: AuthenticatedActor, target: IdentityScope, permission: Permission, nowMs: number): void {
  integer(nowMs); integer(actor.expiresAtMs); identifier(actor.deviceId);
  invariant(actor.tenantId === target.tenantId && actor.application === target.application && actor.identityId === target.identityId, 'ACCESS_SCOPE_MISMATCH');
  invariant(actor.expiresAtMs > nowMs && actor.permissions.includes(permission), 'ACCESS_DENIED');
}
export interface DeviceKey { id: string; algorithm: 'ALG-ED25519' | 'ALG-X25519'; publicKeyHex: string }
export interface DeviceRecord { id: string; generation: number; signing: DeviceKey; agreement: DeviceKey; status: 'active' | 'revoked' }
export interface DeviceEventBody {
  scope: IdentityScope;
  sequence: number;
  precedingStateHashHex: string;
  action: 'enroll' | 'rotate' | 'revoke';
  deviceId: string;
  replacement: Omit<DeviceRecord, 'status'> | null;
}
export interface SignedDeviceEvent { body: DeviceEventBody; rootSignatureHex: string }
const encoder = new TextEncoder();
function eventBytes(body: DeviceEventBody): Uint8Array<ArrayBuffer> {
  return encoder.encode(canonicalJson({domain:'DAE-DEVICE-EVENT-v1',body}));
}
function hex(input: Uint8Array): string { return Array.from(input,x=>x.toString(16).padStart(2,'0')).join(''); }
function unhex(input: string): Uint8Array<ArrayBuffer> {
  invariant(typeof input === 'string' && /^[0-9a-f]{128}$/.test(input),'INVALID_IDENTITY_SIGNATURE');
  return Uint8Array.from(input.match(/.{2}/g)!.map(x=>parseInt(x,16)));
}
export async function signDeviceEvent(body: DeviceEventBody, rootPrivateKey: EndpointCryptoKey): Promise<SignedDeviceEvent> {
  invariant(rootPrivateKey.type === 'private' && rootPrivateKey.algorithm.name === 'Ed25519','INVALID_ROOT_KEY');
  const snapshot=structuredClone(body);
  return {body:snapshot,rootSignatureHex:hex(new Uint8Array(await crypto.subtle.sign('Ed25519',rootPrivateKey,eventBytes(snapshot))))};
}
/** Account-root profile. Replay authenticated events to restore state; no server-only enrollment. */
export class DeviceRegistry {
  private sequence = 0;
  private readonly devices = new Map<string,DeviceRecord>();
  private readonly retiredKeyIds = new Set<string>();
  private readonly usedFingerprints = new Set<string>();
  private readonly scope: IdentityScope;
  constructor(scope: IdentityScope, private readonly pinnedRootPublicKey: EndpointCryptoKey) {
    this.scope=structuredClone(scope); identifier(scope.tenantId);identifier(scope.identityId);
    invariant(scope.application==='scenesignal'||scope.application==='distributed-radio','INVALID_APPLICATION');
    invariant(pinnedRootPublicKey.type==='public'&&pinnedRootPublicKey.algorithm.name==='Ed25519','INVALID_ROOT_KEY');
  }
  snapshot() {
    return {scope:structuredClone(this.scope),sequence:this.sequence,devices:[...this.devices.values()].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0).map(x=>structuredClone(x)),retiredKeyIds:[...this.retiredKeyIds].sort()};
  }
  async stateHash(): Promise<string> {
    const hash=await crypto.subtle.digest('SHA-256',encoder.encode(canonicalJson(this.snapshot())));
    return hex(new Uint8Array(hash));
  }
  isActive(deviceId: string): boolean { return this.devices.get(deviceId)?.status==='active'; }
  activeRecipients(): string[] { return [...this.devices.values()].filter(d=>d.status==='active').map(d=>d.id).sort(); }
  async apply(event: SignedDeviceEvent): Promise<void> {
    const local=structuredClone(event); const body=local.body;
    invariant(Object.keys(local).sort().join(',')==='body,rootSignatureHex','UNKNOWN_IDENTITY_FIELDS');
    invariant(body && Object.keys(body).sort().join(',')==='action,deviceId,precedingStateHashHex,replacement,scope,sequence','UNKNOWN_IDENTITY_FIELDS');
    invariant(canonicalJson(body.scope)===canonicalJson(this.scope),'IDENTITY_SCOPE_MISMATCH');
    integer(body.sequence,1); identifier(body.deviceId);
    invariant(['enroll','rotate','revoke'].includes(body.action),'INVALID_DEVICE_ACTION');
    const expectedSequence=this.sequence;
    const stateHash=await this.stateHash();
    invariant(body.sequence===expectedSequence+1&&body.precedingStateHashHex===stateHash,'IDENTITY_REPLAY_OR_ROLLBACK');
    invariant(await crypto.subtle.verify('Ed25519',this.pinnedRootPublicKey,unhex(local.rootSignatureHex),eventBytes(body)),'IDENTITY_AUTHENTICATION_FAILED');
    invariant(this.sequence===expectedSequence,'IDENTITY_CONCURRENT_UPDATE');
    const current=this.devices.get(body.deviceId);
    if(body.action==='revoke') {
      invariant(body.replacement===null&&current?.status==='active','INVALID_REVOCATION');
      invariant(this.activeRecipients().length>1,'LAST_DEVICE_REVOCATION');
      current.status='revoked'; this.retiredKeyIds.add(current.signing.id);this.retiredKeyIds.add(current.agreement.id);
    } else {
      const next=body.replacement;
      invariant(next && Object.keys(next).sort().join(',')==='agreement,generation,id,signing','INVALID_DEVICE_RECORD');
      invariant(next.id===body.deviceId,'DEVICE_ID_MISMATCH');integer(next.generation,1);
      if(body.action==='enroll') invariant(!current&&next.generation===1,'DEVICE_ID_REUSE');
      else invariant(current?.status==='active'&&next.generation===current.generation+1,'INVALID_DEVICE_ROTATION');
      invariant(next.signing.algorithm==='ALG-ED25519'&&next.agreement.algorithm==='ALG-X25519','INVALID_KEY_ROLE');
      invariant(next.signing.id!==next.agreement.id&&next.signing.publicKeyHex!==next.agreement.publicKeyHex,'DEVICE_KEY_COLLISION');
      for(const key of [next.signing,next.agreement]) {
        invariant(Object.keys(key).sort().join(',')==='algorithm,id,publicKeyHex','UNKNOWN_DEVICE_KEY_FIELDS');identifier(key.id);
        invariant(/^[0-9a-f]{64}$/.test(key.publicKeyHex)&&!/^0+$/.test(key.publicKeyHex),'INVALID_PUBLIC_KEY');
        invariant(!this.retiredKeyIds.has(key.id),'RETIRED_KEY_REUSE');
        invariant(![...this.devices.values()].some(d=>d.signing.id===key.id||d.agreement.id===key.id),'CURRENT_KEY_REUSE');
        invariant(!this.usedFingerprints.has(key.publicKeyHex),'PUBLIC_KEY_REUSE');
      }
      if(current){this.retiredKeyIds.add(current.signing.id);this.retiredKeyIds.add(current.agreement.id);}
      this.devices.set(next.id,{...next,status:'active'});
      this.usedFingerprints.add(next.signing.publicKeyHex);this.usedFingerprints.add(next.agreement.publicKeyHex);
    }
    this.sequence++;
  }
}
