# Atomic endpoint delivery journal

October 13, 2026. Node endpoint integration only; not a relay, mobile app or
independently reviewed release. Refinement of DAE-03/08/23/26/34, with no added
milestones. See `registry/endpoint-journal.json` and the canonical roadmap.

## Transaction boundary

`SignalParentChannel.queueMessage` commits the exact outbound ciphertext and
ratchet state in the **same encrypted vault row**. `queueControl` additionally
signs the complete encrypted control before that commit. A signing, size-limit,
revocation or persistence failure releases neither the wire nor its signature.
The caller must durably choose an operation ID before invoking either method and
retry the identical ID, payload, recipient, kind and expiry after an uncertain
result. Conflicting reuse fails closed. Outbound storage retains no plaintext
request, only a request digest and the ciphertext packet.

`receiveQueued` authenticates the Signal message and commits its private envelope
alongside consumed prekeys and ratchet state before releasing plaintext. A repeat
of the same wire returns the pending envelope without decrypting a consumed
ratchet again. `pendingMessages(sender)` recovers pending envelopes after reopen.
`completeMessage(messageKey)` removes the payload and retains a replay tombstone
until the authenticated expiry. A freshly encrypted reuse of a retained message
ID is rejected, even with a different payload or kind.

`pendingDeliveries(recipient)` returns unsent packets. After the existing
ciphertext relay confirms storage, `markDeliverySent(deliveryId)` records that
fact; it **does not mean the recipient executed anything**. The ciphertext stays
available to an identical explicit retry until expiry, including after a lost
relay response or uncertain local commit. Consumers must recheck current peer
membership before sending a retained packet; a previously returned JavaScript
object does not confer continuing permission.

## Limits and recovery

The journal is limited to 64 combined incoming/outgoing entries, including sent
records and completed tombstones, and 512 KiB of canonical serialized data. The
vault's existing overall 1 MiB bound still applies. Capacity exhaustion rejects
the entire transaction rather than dropping live replay protection. Explicit
`sweepJournal()` and subsequent state transactions remove expired entries. There
is no background sweeper in an inactive endpoint. Expiry is logical removal from
the current encrypted snapshot, not a secure-erasure claim about old filesystem
blocks, backups or JavaScript garbage collection.

Reopen requires the original endpoint key, verified registry, current explicit
peer permissions and the independently protected revision floor. Permissions do
not persist as automatic grants. Clock rollback, key rotation, revocation and
expiry remain authoritative for cached messages and retries. Corrupt journals
are not silently reset. Do not clear a stale filesystem lock until exclusive
ownership and the existing vault recovery procedure have been established.

## Application integration and explicit limits

These APIs provide durable cryptographic delivery state, not exactly-once
application effects. Commit a business effect and its operation-ID deduplication
in the application's own transaction before marking its inbox entry completed.
An uncertain application commit must be reconciled, not blindly replayed.

Do not mix `receive` and `receiveQueued` for a durable flow: the old low-level API
intentionally exposes no recoverable inbox. Likewise `seal` and
`createSignalControl` retain their existing non-journal contracts. The [Node recovery composition](endpoint-relay-recovery.md) now supplies bounded
relay acknowledgment ordering and opt-in durable `SignalPlaybackInbox` rehydration.
Its default non-durable behavior remains available. A signed-control replay
checkpoint is a distinct row: it must never be reset to resume an old lease.
After an uncertain playback command, keep output stopped and obtain fresh signed
control authority. Emergency handling and independent native hard stops remain
unchanged.

Automatic playback resumption, mobile runtime/protocol bindings, hardware-protected keys/floors, actual device
latency/soaks, deployment and operational recovery drills remain open. Independent
expert review is deferred follow-up, not a prerequisite under the owner policy in
`AGENTS.md`; source-bound AI review and passing tests remain required. No test here establishes exactly-once sound or device
qualification.

## Verification

The PR #56 journal checkpoint added 18 real-library journal/transaction cases and five pure
journal-model cases. They cover reopen, simulated failure before and after a
commit, duplicate/conflicting IDs, missing permissions after reopen, current
membership, expiry during an asynchronous operation, quotas, racing instances,
private-at-rest payloads, signed control integration and terminal tombstones.
The subsequent recovery composition brings the endpoint/model total to 70;
10 Signal-to-C rendering cases remain active,
as do Engine, Native, Relay and E2EESA status-record checks. All exact-head hosted
checks must pass before merge. Local Node 22/TypeScript 5 checks are supplementary
to the pinned hosted Node 24.19/TypeScript 7 runtime; record validation is not an
independent security review.
