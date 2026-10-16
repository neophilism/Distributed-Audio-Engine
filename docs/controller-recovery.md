# Durable endpoint controller issuance

`DurableSignalController` closes the controller-side gap left by the endpoint
journal: stable operation IDs, epochs, sequence numbers and private command
intents now survive a controller restart. It uses the existing encrypted endpoint
vault and actual Signal channel. It is not a new cryptographic protocol, a relay
key service, automatic playback recovery or exactly-once application execution.

## Use at the authorized controller endpoint

```js
const controller = new DurableSignalController({ vault, channel, nowUnixMs });
const delivery = await controller.issue({
  operationId: persistedApplicationOperationId,
  recipient: authorizedListenerAddress,
  action: 'lease',
  expiresAtMs: nowUnixMs() + 5000,
  payload: {
    expiresAtMs: nowUnixMs() + 3000,
    stopAtMs: nowUnixMs() + 3000,
    fadeMs: 100,
    maxLinearGain: 0.25,
  },
});
await exchange.flush(authorizedListenerAddress);
```

The caller supplies already root-verified membership, endpoint-only keys and the
existing encrypted vault. Use a stable application operation ID. Do not generate
another ID just because a result was lost. Repeating `issue` requires identical
request fields; `resume(operationId)` uses the original saved fields and exact
ciphertext. `pending()` returns metadata for unresolved reservations, not private
payloads, keys, ciphertext or a playback-success flag. If a generated ID itself
was not retained by the caller, inspect those pending reservations before making
another application decision. Completed queue operations remain retryable by ID
through expiry. Closing the controller does not close its caller-owned channel or
vault and does not recall ciphertext already queued.

## Crash ordering and bounds

The encrypted `controller-state` row is bound to the exact scope and local device
address. An atomic reservation advances the per-recipient counter and saves the
private intent **before** Signal signing or ratchet work starts. The existing
`queueControl` transaction then saves identical ciphertext with ratchet state.
Only afterward does the controller mark its reservation queued. Crashes before
or after either durable commit are resumed, not translated into another command.
A failed or uncertain reservation prevents another operation ID from skipping its
sequence. Concurrent instances use the vault's compare-and-set; conflicts are
retried at most four times. Capacity never evicts unexpired operation identities.

There are at most 32 recipient streams and 64 retained operations in a 128 KiB
controller row. The existing whole-vault, Signal-journal, peer and message limits
also apply. Controls are bounded to 60 seconds. Expired payloads are pruned on a
later mutation, except an unresolved reservation stays visible until explicitly
reconciled. Sequence counters are retained after expiry. This is logical cleanup,
not guaranteed physical erasure of backups or JavaScript memory.

Membership is checked before issuance/resume and again after asynchronous channel
work. Time rollback, malformed state, mixed identities, conflicting IDs, changed
permissions, unsupported payloads, invalid gains/fades, superseded epochs and
unexpected returned packet headers fail closed. Cached retries do not bypass
those checks. A lease too short to honor its remaining fade is not resumed.

## Explicit reconciliation, never silent reset

After uncertain remote execution or a lost/expired control in a strict sequence,
keep playback stopped and explicitly advance the controller epoch:

```js
const previous = controller.streamState(recipient);
controller.advanceEpoch(recipient, previous.epoch);
// A newly authorized issue now starts at sequence 1 in the higher epoch.
```

The expected epoch is an atomic guard against racing decisions. Advancement can
supersede an in-flight operation, whose late completion cannot finalize or return
a success receipt. It does not retract older ciphertext from the channel outbox,
stop a remote device, reset receiver checkpoints, grant new media rights, send a
message or start output. The application must deliver a fresh signed higher-epoch
control through the existing authenticated channel. The receiver still applies
current membership, replay checkpoints, consent, rights, explicit join and native
deadlines. Flush/intake acknowledgments are not proof of an application effect.

Use one coordinated authorizer for each receiver scope. Multi-controller leader
election and business-effect reconciliation remain application responsibilities.
The caller must persist and protect the vault key and its external revision floor
on reopen; this addition does not make filesystem snapshots hardware anti-rollback.

## Verification and review

Nineteen local controller-model cases exercise reservation/commit uncertainty,
restart, identical retry, epochs, conflicts, bounded retention, clock rollback,
input mutation, revoked peers, late completion and malformed state. These use the
real encrypted vault but an explicitly fake channel; they are not Signal proof.
Five separate tests use the actual pinned Signal implementation and real signed
receiver checkpoints. Eight existing actual TLS-to-production-C scenarios now
issue their controls through the new controller. The other two network restart
cases and all prior suites remain active. Hosted exact-head checks must pass
before merging; source presence alone is not execution evidence.

AI author review covers both crash windows, identity/scope/counter binding,
concurrent reservations, retained private intent, byte-identical retries and the
intake/execution distinction. Independent human review remains separate final
review, not a prerequisite to this development. No production deployment,
physical-device qualification or security certification is claimed here.
