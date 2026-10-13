import { digest, snapshot, exact, integer, identifier, invariant, assertLifetime, MAX_LIFETIME_MS } from './validation.mjs';

/** Encrypted application-level high-water marks, separate from Signal replay
 * state. A replaced/expired manifest must not resurrect older still-live keys
 * after process restart. No attachment key or descriptor is stored in this row.
 */
export class ManifestHeads {
  #vault; #row; #binding;
  constructor(vault, binding) {
    invariant(vault && typeof vault.read === 'function' && typeof vault.compareAndSet === 'function', 'PARENT_MANIFEST_VAULT_REQUIRED');
    this.#vault = vault; this.#binding = digest(binding); this.#row = 'manifest-heads-' + this.#binding;
  }
  remember(message, now) {
    integer(now); assertLifetime(message.issuedAtMs, message.expiresAtMs, now); identifier(message.payload.assetId);
    const row = this.#vault.read(this.#row);
    const state = row === undefined ? { version: 1, binding: this.#binding, lastNowMs: now, heads: [] } : row.value;
    exact(state, ['version', 'binding', 'lastNowMs', 'heads']); integer(state.lastNowMs, 0, now);
    invariant(state.version === 1 && state.binding === this.#binding && Array.isArray(state.heads) && state.heads.length <= 64,
      'PARENT_MANIFEST_HEAD_STATE');
    const ids = new Set();
    for (const head of state.heads) {
      exact(head, ['assetId', 'issuedAtMs', 'fingerprint']); identifier(head.assetId); integer(head.issuedAtMs, 0, now);
      invariant(!ids.has(head.assetId) && typeof head.fingerprint === 'string' && /^[0-9a-f]{64}$/.test(head.fingerprint),
        'PARENT_MANIFEST_HEAD_STATE'); ids.add(head.assetId);
    }
    state.heads = state.heads.filter(head => head.issuedAtMs + MAX_LIFETIME_MS > now);
    const fingerprint = digest(message), previous = state.heads.find(head => head.assetId === message.payload.assetId);
    invariant(!previous || message.issuedAtMs > previous.issuedAtMs ||
      message.issuedAtMs === previous.issuedAtMs && fingerprint === previous.fingerprint, 'PARENT_MANIFEST_ROLLBACK');
    if (previous) { previous.issuedAtMs = message.issuedAtMs; previous.fingerprint = fingerprint; }
    else {
      invariant(state.heads.length < 64, 'PARENT_MANIFEST_HEAD_LIMIT');
      state.heads.push({ assetId: message.payload.assetId, issuedAtMs: message.issuedAtMs, fingerprint });
    }
    state.lastNowMs = now;
    invariant(this.#vault.compareAndSet(this.#row, row?.revision, snapshot(state)), 'PARENT_MANIFEST_HEAD_CONFLICT');
  }
}
