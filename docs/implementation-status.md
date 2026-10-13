# Implementation and evidence status

## Current checkpoint: October 13, 2026

The Node Signal parent channel now has an [atomic endpoint delivery journal](endpoint-journal.md).
Outbound ciphertext, signed encrypted controls and inbound authenticated envelopes
commit with their Signal ratchet state in one encrypted compare-and-set row.
Stable request IDs permit byte-identical retries after an uncertain commit;
completed inbox entries discard private payloads while retaining expiry-bounded
replay tombstones. Current membership, clock/expiry checks and combined byte/count
limits still apply. This is not automatic playback recovery or exactly-once audio.
The [journal record](../registry/endpoint-journal.json) refines the canonical
34-milestone plan without promoting production or review gates.

The Signal suite now includes 54 endpoint/storage/playback/model cases (31 prior
plus 23 journal cases), with 10 separate Signal-to-production-C integration cases.
Exact-head hosted checks remain required before merge; local checks on a different
runtime are supplementary. Test source is not evidence of a passed hosted run.
The PR and GitHub Actions retain the exact tested head and conclusions.

The [TLS ciphertext relay](../services/ciphertext-relay/README.md) and endpoint
client deliver public prekeys, encrypted manifests/controls and bounded encrypted
audio chunks. Its 24 SQLite/TLS/launcher cases and eight Signal-to-TLS-to-C cases
remain active. It is runnable with explicit operator configuration, not deployed.
The new journal API still needs relay polling/acknowledgment orchestration and
playback-manifest rehydration; the existing playback inbox remains volatile.

The portable engine retains 197 tests, including 23 owned-session cases. Native
checks retain 13 C contract cases plus 10,000 adversarial sequences/concurrency,
17 Swift/C/JavaScriptCore cases and seven Java/JNI/C cases. Additional signed-media
integration has 17 Node-to-C cases. Hosted native jobs compile the actual unsigned
iOS simulator target and Android arm64-v8a/x86_64 libraries with lint. ASan/UBSan,
strict types, dependency audit, source boundaries, roadmap DAG and offline packed
consumer checks remain separate gates.

## What is implemented versus what remains

| Area | Implemented software | Remaining gates |
|---|---|---|
| Endpoint encryption | Pinned real libsignal parent channel, root-verified peer membership, encrypted atomic vault and bounded delivery journal | Mobile protocol bindings, protected keys/revision floors, account recovery and independent protocol/profile/license review |
| Audio delivery | Endpoint AES-GCM packaging, authenticated ranges, immutable ciphertext relay chunks, signed controls and current rights checks | Durable relay/playback recovery composition, deployed transport, codec/loudness/native format integration |
| Native playback | Shared C kernel, foreground Android AudioTrack/JNI and iOS AVAudioEngine/Swift hosts; actual system JavaScriptCore audio bridge | Android runtime bridge, full endpoint bootstrap/web-crypto/module loading, explicit rate/channel/drift adapters and consuming apps |
| Timing/output evidence | Monotonic timeline checks, challenge-bound conservative intervals, native fades/hard stops and route invalidation | Physical calibration/attribution, audible stop latency, Bluetooth/wired delays, supported-device matrix and six-hour soaks |
| Business and operations | Scoped rights, immutable checkout, SQLite purchases/accounting/entitlements, sponsorship and observability/evidence primitives | Real provider signatures/APIs/sandbox/dispatch, complete-product/refund fulfillment, durable sponsor adapters, deployed observability and restore/retention/deletion drills |
| Advanced capabilities | Neutral spatial/mixing primitives, local coordination and bounded ciphertext caches | Resampling/topology/positioning pilots, LAN provisioning, live input and advanced hardware per existing dependencies |

Both mobile hosts remain **foreground-only**. Calls, interruptions, route changes,
foreground loss and lock screen stop output and require an explicit new join.
Software callbacks and simulated routes cannot prove audible stopping or acoustic
synchronization. No optional background-playback qualification is claimed.

No cloud deployment, registry publication, app signing, new paid resource, stable
release, physical-speaker trial or independent certification is claimed. Source
and CI artifacts are development SDK deliverables, not a turnkey mobile app.
Check dependent repositories separately before making application-level claims.

## Evidence and next execution order

The [October 12 checkpoint](implementation-status-2026-10-12.md) preserves the
previous capability table, PR history and evidence boundaries. Its references to
an absent Node endpoint journal and 31 endpoint tests are superseded only by the
new scoped journal record. Other unpassed gates are unchanged.

Continue with relay acknowledgment ordering and recoverable manifest composition,
then Android runtime bridging and complete endpoint bootstrap/mobile protocol
bindings. Integrate protected native state and explicit rate/channel/drift
adapters. Qualify physical routes/interruptions/rejoin and six-hour soaks. Complete
provider/fulfillment and deployed operational drills before artifact-bound
independent review and release. See the [development plan](DEVELOPMENT_PLAN.md),
[native plan](../native/README.md) and [canonical roadmap](../registry/roadmap.json).
