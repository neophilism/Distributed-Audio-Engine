# Node relay and playback recovery

This composes the atomic journal from PR #56 with the ciphertext relay and the
owned playback session. It remains endpoint-only: no media key, private manifest,
private control payload or clear audio is sent to the relay. Physical devices,
mobile runtimes and deployment remain separate gates. External expert review is
deferred follow-up, not a merge/release prerequisite under the October 13 owner
policy in `AGENTS.md`; source-bound AI security review and tests remain required.

## Intake versus execution

`SignalParentChannel.receivePacket(packet, expectedSender)` validates the relay
sender, record type, delivery ID and expiry against the authenticated inner
message. Signed controls are signature/scope/action/lifetime checked before their
Signal ratchet is consumed; the encrypted inner header must match the signed
outer header. The complete signed ciphertext packet and authenticated envelope
then commit with receiving ratchet state. Forged or conflicting metadata does not
advance it. Completed messages discard both private envelope and retained packet,
leaving only bounded replay metadata.

The new portable `authenticateControl` helper is **authentication for intake, not
execution authorization**. It deliberately does not advance the separate replay
checkpoint. Playback still uses `ControlVerifier.accept`, current membership,
rights/consent, an explicit join and independently bounded native envelopes.
Storing or recovering a lease neither executes it nor resets its replay counter.

`SignalRelayEndpoint` takes an existing channel, trusted abort-aware transport
(`CiphertextRelayClient`) and clock. `flush(recipient)` sends at most eight pending
packets with current peer checks, and marks them sent only after a valid relay
storage receipt. `pull()` authenticates and durably stores each packet **before**
acknowledging its relay receipt. Both calls are single-flight, cancelable and have
a bounded operation deadline (default 10 seconds). There is no polling timer,
background retry, automatic enrollment, automatic playback or plaintext fallback.
Closing this wrapper aborts its work, not the caller-owned channel or transport.

A lost response can leave a committed prefix even when a call throws. Retry the
same saved outgoing operation IDs; do not re-encrypt with new IDs. Recover local
pending messages after a lost acknowledgment/result. Current permissions and
expiry still govern cached messages and retries. Once sent, ciphertext cannot be
recalled from an untrusted transport. Acknowledgment proves durable endpoint
intake only, never a business effect, playback execution or audible output.

## Explicit manifest recovery

Construct `SignalPlaybackInbox` with `{ durable: true, vault }`, using the existing
encrypted endpoint vault (or a separately reviewed equivalent). Call
`restoreManifests()` explicitly before a new join. It revalidates pending private
contexts, manifests, current membership and grants, selecting the newest version
per asset. Ambiguous same-time replacements and invalid recovery fail closed and
clear volatile keys. Default non-durable mode preserves its existing contract.

The encrypted application row also retains per-asset high-water marks before a
new descriptor can be installed. This prevents an older retained key from
resurrecting after its installed replacement expires. These rows contain hashes
and IDs, not attachment keys; they are bound to the scope, sender and receiver.
Up to 64 live high-water marks are retained through the five-minute maximum
message lifetime, independently of the eight-asset volatile cache. The journal's
64-entry/512 KiB and whole-vault 1 MiB limits still apply. Expiry is logical cleanup,
not a filesystem/backup secure-erasure claim. Protected revision floors and the
existing vault lock/recovery procedure remain required across process restarts.

An inbox entry needed for manifest rehydration must remain pending until no
longer needed or expired. Do not complete it immediately after relay intake.
Application effects need their own idempotent transaction before completion.
Consumed controls remain consumed after restart. After an uncertain command,
keep output stopped and obtain fresh signed authority; a new higher epoch starting
at sequence one can reconcile uncertainty without resetting the receiver's stored
checkpoint. Controllers must persist their own operation IDs and epoch decisions.

## Minimal endpoint composition

```js
const exchange = new SignalRelayEndpoint({ channel, relay, nowUnixMs: Date.now });
const inbox = new SignalPlaybackInbox({
  channel, sender, nowUnixMs: Date.now, durable: true, vault,
});

// Sender: persist this operation ID before starting. Retries use identical fields.
await channel.queueMessage(recipient, 'manifest', descriptor, {
  messageId: descriptor.context.parentMessageId,
  expiresAtMs: descriptor.authorizationValidUntilMs,
});
await exchange.flush(recipient);

// Receiver: durable intake first; no playback is started by either operation.
await exchange.pull();
await inbox.restoreManifests();
const pending = await channel.pendingMessages(sender);
// A trusted application decides what to apply. Use owned playback sessions and
// their replay-safe verifier for controls, never authenticateControl alone.
```

## Evidence boundaries

New verification consists of three portable authentication cases, 12 actual-Signal
packet/relay/recovery cases, four high-water model cases and two actual TLS-to-C
restart cases (Android and iOS host contracts). Totals are 200 portable cases,
70 endpoint/model cases, ten separate Signal-to-C cases and ten TLS-to-C cases,
with the existing 24 relay-service cases and native platform/sanitizer checks.
Exact-head hosted success is required before merge. Local Node 22/TypeScript 5
results supplement, not replace, the pinned Node 24.19/TypeScript 7 hosted runs.
Native route clocks in integration tests are synthetic; no acoustic, physical
power-loss, hardware-key, deployment or independent-security qualification is
claimed. See `registry/endpoint-recovery.json` and `docs/implementation-status.md`.
