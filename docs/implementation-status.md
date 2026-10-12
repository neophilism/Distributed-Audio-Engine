# Implementation and evidence status

## Current checkpoint: October 12, 2026

The engine now includes real foreground Android and iOS playback host source,
not only portable host interfaces. PR #44 added reproducible development
artifacts; #45 added the shared native PCM kernel and six portable regressions;
#46 added the Swift/iOS host; #47 added the Java/JNI/Android host. Exact-head
hosted checks are required before each merge. These changes close the missing
native-host implementation layer, not the integrated production release.

The portable suite has **168 tests**. Separate native verification has **13 C
contract cases** (plus 10,000 adversarial sequences and concurrency tests), **7
Swift/C cases**, and **7 Java/JNI/C cases**. Hosted checks also build the actual
iOS-only host for an unsigned simulator target and compile/lint the Android
library for arm64-v8a and x86_64. ASan/UBSan, dependency audit, strict types,
source boundaries, roadmap DAG and offline packed-consumer checks remain active.
Software checks and compilation do not establish audible output or acoustic sync.

Both mobile hosts are deliberately **foreground-only**: interruption, route
loss, app switching or lock screen stop output and require explicit restart and
fresh timeline join. There is no background/lock-screen playback claim.

The canonical 34-milestone scope/count remains unchanged. The current native PR
mapping, implementation scope and unpassed gates are in
[`registry/native-implementation.json`](../registry/native-implementation.json),
referenced by [`registry/roadmap.json`](../registry/roadmap.json). That supplement
supersedes native-host descriptions in the historical October 10 detailed
`docs/roadmap.json` snapshot; it does not promote its deployment, integration,
field, stable-release or independent-review flags. The original roadmap
milestones and build order remain authoritative.

## Capability boundaries

| Area | Current scope | Remaining integration or qualification |
|---|---|---|
| Encryption/delivery | Endpoint AES-GCM chunks, private manifests, bounded authenticated ranges, complete-file hash and HTTPS response limits | Authenticated parent key channel, independent crypto/interoperability review |
| Canonical inputs | Stable v1 valid bytes, Unicode/order vectors, bounded parsing and duplicate/member rejection | Explicit versioned migration when an approved upstream contract changes |
| Playback | Current-position linear player, rights/recipient expiry, bounded PCM queues, browser graph, shared native PCM kernel, Android AudioTrack/JNI and iOS AVAudioEngine/Swift foreground hosts | Consumer runtime wiring, exact-format/rate/drift integration, physical route/interruption tests and any separately implemented background policy |
| Controls/clock | Scoped signatures, leases/emergency supersession, SQLite replay checkpoints, challenged clock intervals | Native protected state, E2EE payload delivery, route-specific output delay and acoustic measurements |
| Output evidence | Active-route invalidation, post-challenge measurement decisions, full-window calibration, immutable conservative intervals and physical-output coverage | Physical calibration/source/output attribution, consented measurement integration and independent qualification |
| Local coordination/cache | Primary leases, registered opaque transports, bounded failover and quota/expiry SQLite ciphertext cache | LAN discovery/provisioning and replica/restore qualification |
| Identity/rights | Root-authorized device events, tenant/app roles and explicit layered permissions | Real identity provisioning, root/recovery storage, agreement protocol and rights persistence |
| Ingestion/media | Resumable ciphertext ingest, bounded WAV/PCM packaging, sample alignment and digital peak/RMS | Durable upload/object-store adapters, compressed codecs, integrated loudness analysis and native consumer integration |
| Spatial | Neutral scenes, bounded mono mixtures and fixed/object tracking | Resampling/topology choreography, positioning hardware and pilots |
| Checkout | Immutable complete-product quotes, all-asset rights, exact money, provider idempotency, verified-event seam and SQLite purchase state | Real provider signature/API adapter, sandbox and complete-product fulfillment |
| Reconciliation | Exact splits, cumulative refunds, visible liabilities/failures, atomic transfer reservations and SQLite accounting | Actual transfer/refund dispatch, provider sandbox, recovery and production operations |
| Entitlements | Atomic scoped grants, source deduplication, expiry, terminal revocation and SQLite persistence | Source verification, purchase/refund/contribution integration and real recipient/key delivery |
| Sponsorship | Scoped approved campaigns, authenticated delivery facts, quotas and separately referenced qualified output | Durable provider/evidence adapters, billing integration and production operations |
| Observability | Freshness-aware fail-unknown health, nullable aggregates and currency-separated cost snapshots | Authenticated hosted ingestion, persistence, alerting and access controls |
| Operations assurance | Exact-scope verified evidence records, artifact/standard binding, replay and staleness rejection, explicit missing/failed retention/deletion/restore/review gates | Deployed drills, external evidence custody/verifier, independent review and E2EESA corrected-candidate assessment |

## Earlier implementation round (through PR #40)

| PR | Result |
|---|---|
| [#25](https://github.com/neophilism/Distributed-Audio-Engine/pull/25) | Canonical v1 input hardening and duplicate-key parsing |
| [#26](https://github.com/neophilism/Distributed-Audio-Engine/pull/26) | Challenged output evidence, whole-window calibration and immutable coverage receipts |
| [#27](https://github.com/neophilism/Distributed-Audio-Engine/pull/27) | Complete-product checkout and bound settlement events |
| [#28](https://github.com/neophilism/Distributed-Audio-Engine/pull/28) | Exact splits, cumulative refunds and transfer reconciliation |
| [#29](https://github.com/neophilism/Distributed-Audio-Engine/pull/29) | Durable purchase/accounting state, private files and process races |
| [#30](https://github.com/neophilism/Distributed-Audio-Engine/pull/30) | Atomic entitlement grants and durable source deduplication |
| [#31](https://github.com/neophilism/Distributed-Audio-Engine/pull/31) | Roadmap/evidence reconciliation and component/data-flow inventory |
| [#32](https://github.com/neophilism/Distributed-Audio-Engine/pull/32) | Scoped sponsor campaigns and authenticated delivery accounting primitives |
| [#34](https://github.com/neophilism/Distributed-Audio-Engine/pull/34) | Fail-unknown engine observability and cost snapshots |
| [#36](https://github.com/neophilism/Distributed-Audio-Engine/pull/36) | Partial Android host SDK with monotonic scheduling and lifecycle invalidation |
| [#37](https://github.com/neophilism/Distributed-Audio-Engine/pull/37) | Partial iOS host SDK with host-time scheduling and audio-session invalidation |
| [#38](https://github.com/neophilism/Distributed-Audio-Engine/pull/38) | Partial DAE-22 fail-closed operations assurance and evidence boundaries |
| [#40](https://github.com/neophilism/Distributed-Audio-Engine/pull/40) | Serialized replay reservations and immutable verifier inputs for DAE-22 |

## Work remaining

The next software work is the consuming runtime bridge and an actual authenticated
parent channel for private manifests, recipient keys and control payloads, plus
protected native state and explicit rate/channel/drift adapters. Do not describe
those as merely hardware testing. Native classes intentionally do not implement
key agreement or turn an unauthenticated message into playback authority.

Physical devices must then qualify route changes, calls, interruptions, foreground
loss/rejoin, Bluetooth and wired delay, audible stop latency, drift and six-hour
soaks. The supported-device matrix, calibrated acoustic attribution, optional
background playback implementation and independent protocol/security review are
still required for the corresponding claims.

Complete-product/refund fulfillment, actual payment-provider sandbox/dispatch,
durable sponsor/provider adapters, deployed observability and retention/deletion/
restore drills remain separate outstanding integrations. Optional live-input and
advanced-hardware adapters follow their existing dependencies. See the full
[development plan](DEVELOPMENT_PLAN.md) and [native plan](../native/README.md).

No service has been deployed, no registry package or stable release has been
published, and no physical-speaker trial or independent release certification is
claimed. Native source and CI artifacts are development SDK deliverables, not a
turnkey mobile application. Dependent application status must be checked in each
application repository before making a current application-level claim.
