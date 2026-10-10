# Distributed-Audio-Engine: canonical development plan

Original source: [docs/distributed-audio-engine-development-plan.md](../docs/distributed-audio-engine-development-plan.md). Full detailed milestone and acceptance plan follows unchanged.

**Cross-account handoff:** Review `docs/implementation-status.md`, `docs/roadmap.json`, dependency repositories and current GitHub PR/CI evidence before starting another milestone. A planned milestone is not evidence of implementation. The original documents include dependencies and hardware validation gates; do not bypass them.

---

# Distributed-Audio-Engine: development plan

Current implementation and evidence are recorded in [implementation status](implementation-status.md) and [roadmap.json](roadmap.json). Planning IDs below are separate from GitHub PR numbers.

Requested order: Distributed-Audio-Engine → SceneSignal → Distributed-Radio-Engine → TrackZero.

## DAE-01 — Architecture, contracts, repository and CI

Dependencies: None. Origin: original (DAE-01).

Neutral TypeScript contracts, CI, four-repository plans, E2EESA pinned baseline and documented trust boundaries. No consumer branding or reward economics in core.

Acceptance: Typecheck, core boundary/static checks, roadmap dependency validation, build and contract tests pass. Every release and field state remains separately reported.

Gate: Actual field evidence for hardware/production claims.

## DAE-02 — Device and acoustics feasibility harness

Dependencies: DAE-01. Origin: original (DAE-02).

Record reference captures, device routes, timing, calibration uncertainty and failures without treating test data as field evidence.

Acceptance: Simulations never enable a hardware compatibility or verified-volume claim.

Gate: Actual field evidence for hardware/production claims.

## DAE-03 — Identity, tenants and scoped roles

Dependencies: DAE-01, DAE-34. Origin: original (DAE-03).

Scoped capabilities and endpoint-controlled enrollment/revocation. Tenant, application, device and operation isolation; separate service login from E2EE recipient authority. Authentication and durable persistence are adapters.

Acceptance: Cross-tenant/application, expired capabilities, forged enrollment, rollback, reused devices and revoked authorizers are rejected. External identity provisioning is explicitly separate.

Gate: Actual field evidence for hardware/production claims.

## DAE-04 — Secure asset ingestion

Dependencies: DAE-03, DAE-33. Origin: original (DAE-04).

Resumable ciphertext-only ingestion, quotas, checksums, idempotency, expiry and quarantine. Probe/transcode at authorized endpoints; storage never receives a private manifest or key.

Acceptance: Interrupted ciphertext transfers resume; digest mismatch, oversized upload, mixed tenant/application and mutated duplicate chunks fail closed. No server plaintext processing.

Gate: Actual field evidence for hardware/production claims.

## DAE-05 — Rights and permitted-use records

Dependencies: DAE-04. Origin: original (DAE-05).

Evaluate explicit permissions for playback, distribution, caching, rewards and spatial use.

Acceptance: Absent, revoked, expired or geographically incompatible permissions deny new delivery.

Gate: Actual field evidence for hardware/production claims.

## DAE-06 — Media packaging and loudness metadata

Dependencies: DAE-04, DAE-05, DAE-33. Origin: original (DAE-06).

Authorized-endpoint media packaging, sample counts/alignment, waveform and peak/loudness metadata, bounded gain and independent encryption of renditions. Codec/transcoder plugins never run inside ciphertext-only relays.

Acceptance: Known PCM fixtures validate duration, peaks, alignment, clipping and encrypted package integrity. Unsupported codecs or measurement configurations fail closed; no LUFS claim from peak measurements.

Gate: Actual field evidence for hardware/production claims.

## DAE-07 — Canonical generic audio timeline

Dependencies: DAE-06. Origin: original (DAE-07).

Deterministic neutral asset timeline, epochs, revisions, loops, fallback clips and future-effective publication. Generic transition markers; radio show/song/outro and reward semantics belong to Distributed Radio Engine.

Acceptance: Join times resolve identical clip/sample targets. Revisions switch atomically at agreed boundaries without duplicate/omitted content; no consumer dependency.

Gate: Actual field evidence for hardware/production claims.

## DAE-08 — Encrypted delivery and broad-compatibility adapter

Dependencies: DAE-07, DAE-33. Origin: original (DAE-08).

Ciphertext segment transport, cache adapters, endpoint decryption and playback clock integration. Browser interoperability is a playback claim; tighter acoustic synchronization needs separate qualification.

Acceptance: Route and transport errors do not imply acoustic calibration.

Gate: Actual field evidence for hardware/production claims.

## DAE-09 — Android audio SDK

Dependencies: DAE-08. Origin: original (DAE-09).

Build native Android endpoint playback and output lifecycle integration.

Acceptance: Actual Android devices cover interruptions, lock screen, output changes and reconnects.

Gate: Actual field evidence for hardware/production claims.

## DAE-10 — iOS audio SDK

Dependencies: DAE-08. Origin: original (DAE-10).

Build native iOS endpoint playback and output lifecycle integration.

Acceptance: Actual iOS devices cover interruptions, lock screen, permissions and reconnects.

Gate: Actual field evidence for hardware/production claims.

## DAE-11 — Clock discipline and acoustic timing

Dependencies: DAE-02, DAE-09, DAE-10. Origin: original (DAE-11).

Estimate clock offset/drift and compensate only for supported measured output delays.

Acceptance: Qualifying acoustic claims reference real skew measurements and route-specific evidence.

Gate: Actual field evidence for hardware/production claims.

## DAE-12 — Device profiles and route evidence

Dependencies: DAE-09, DAE-10. Origin: original (DAE-12).

Distinguish active output, supported capabilities and route revision changes.

Acceptance: A paired device or renamed headphone is insufficient speaker proof.

Gate: Actual field evidence for hardware/production claims.

## DAE-13 — Opt-in acoustic evidence adapters

Dependencies: DAE-02, DAE-12. Origin: original (DAE-13).

Process consented calibration and attribution evidence at an authorized endpoint.

Acceptance: Stale, ambiguous or replayed observations cannot be labeled verified output.

Gate: Actual field evidence for hardware/production claims.

## DAE-14 — Qualifying-window and level evaluator

Dependencies: DAE-11, DAE-13. Origin: original (DAE-14).

Intersect valid output, calibrated measurement and interval bounds conservatively.

Acceptance: Uncertain boundaries, expired evidence and interruptions never generate verified intervals.

Gate: Actual field evidence for hardware/production claims.

## DAE-15 — Neutral contribution-policy primitives

Dependencies: DAE-05, DAE-14. Origin: original (DAE-15).

Reusable bounded measurement-band and interval rules. No artist points, song vesting, exponential reward pricing, radio cadence or Groove economics in the core.

Acceptance: Invalid bounds, stale calibration, insufficient assurance and out-of-limit intervals cannot qualify. Policies cannot raise a user volume.

Gate: Actual field evidence for hardware/production claims.

## DAE-16 — Generic entitlement ledger primitives

Dependencies: DAE-15. Origin: original (DAE-16).

Atomic, idempotent non-product-specific entitlement grants and access records with persistence adapter. Radio points wallets and reward redemptions live in Distributed Radio Engine.

Acceptance: Replay and concurrent grant requests never create duplicate rights.

Gate: Actual field evidence for hardware/production claims.

## DAE-17 — Album checkout and payment adapter

Dependencies: DAE-03, DAE-05, DAE-06. Origin: original (DAE-17).

Abstract complete-product purchases and payment-provider events.

Acceptance: Signed idempotent settlement events bind the correct product and buyer.

Gate: Actual field evidence for hardware/production claims.

## DAE-18 — Splits, refunds and reconciliation

Dependencies: DAE-17. Origin: original (DAE-18).

Reconcile fees, agreed shares, refunds and transfer failures.

Acceptance: Sandbox transactions balance and rejected transfers stay visible.

Gate: Actual field evidence for hardware/production claims.

## DAE-19 — Sponsor campaigns and delivery accounting

Dependencies: DAE-07, DAE-18. Origin: original (DAE-19).

Track approved campaign records and generic media deliveries.

Acceptance: Reports distinguish delivery, output verification and people.

Gate: Actual field evidence for hardware/production claims.

## DAE-20 — Anti-abuse and signed evidence

Dependencies: DAE-03, DAE-14, DAE-16. Origin: original (DAE-20).

Bind challenges, evidence scope, validity and replay keys.

Acceptance: Forged and duplicated evidence cannot affect grants.

Gate: Actual field evidence for hardware/production claims.

## DAE-21 — Observability, cost and roadmap exports

Dependencies: DAE-08, DAE-16, DAE-18, DAE-19. Origin: original (DAE-21).

Expose health and roadmap status with explicit unknown values and cost controls.

Acceptance: Missing data is not a zero or a passing validation.

Gate: Actual field evidence for hardware/production claims.

## DAE-22 — Security, privacy and operations baseline

Dependencies: DAE-05, DAE-20, DAE-21. Origin: original (DAE-22).

Integrate E2EESA requirements, retention, recovery and maintainable operations.

Acceptance: Deployed restore, deletion and independent security evidence is required before release.

Gate: Actual field evidence for hardware/production claims.

## DAE-23 — Core audio integration candidate

Dependencies: DAE-11, DAE-12, DAE-14, DAE-16, DAE-18, DAE-19, DAE-22. Origin: original (DAE-23).

Encrypted asset, native playback, clock, evidence, commerce and shared entitlement integration; portable release candidate independently consumable by SceneSignal or radio engine. Hardware-dependent claims require actual evidence.

Acceptance: Software integration evidence, six-hour supported-device soaks, supported-device matrix and unresolved gates published. No dependent app is required to build core.

Gate: Actual field evidence for hardware/production claims.

## DAE-24 — Spatial asset and scene contracts

Dependencies: DAE-01, DAE-06. Origin: original (DAE-24).

Aligned stem/object scene contracts, positions, revisions, capability weights, source spread, fixed positions and neutral physical anchor records. SceneSignal calls a physical instrument anchor a Spime; the core remains neutral.

Acceptance: Invalid positions or incompatible stem lengths cannot produce a scene.

Gate: Actual field evidence for hardware/production claims.

## DAE-25 — Portable spatial DSP renderer

Dependencies: DAE-24. Origin: original (DAE-25).

Compute bounded, capability-aware source weights and render per-output samples.

Acceptance: Known sample fixtures, speaker changes and gain constraints remain musically stable.

Gate: Actual field evidence for hardware/production claims.

## DAE-26 — Local coordinator and edge caching

Dependencies: DAE-08, DAE-24. Origin: original (DAE-26).

Coordinate authorized playback and opaque cache state on a local network.

Acceptance: Host loss, missing segments and interrupted joins produce a bounded fallback.

Gate: Actual field evidence for hardware/production claims.

## DAE-27 — Safety controls and bounded authority

Dependencies: DAE-24, DAE-34. Origin: original (DAE-27).

Implement expiring operating limits and authenticated emergency controls.

Acceptance: Expired authority cannot sustain unattended output indefinitely.

Gate: Actual field evidence for hardware/production claims.

## DAE-28 — Placement and tracking adapters

Dependencies: DAE-24. Origin: original (DAE-28).

Fixed/moving placement and neutral physical-anchor adapters. Track the speaker/object rather than its owner; distinguish BLE presence/range from validated coordinates; confidence and stale data gates.

Acceptance: Owner-phone movement never silently moves a fixed speaker.

Gate: Actual field evidence for hardware/production claims.

## DAE-29 — Optional live-input transport

Dependencies: DAE-11, DAE-27. Origin: original (DAE-29).

Add authenticated encrypted live frames behind a separately qualified latency path.

Acceptance: Real-device measurements justify each live/monitoring compatibility claim.

Gate: Actual field evidence for hardware/production claims.

## DAE-30 — Optional advanced hardware adapters

Dependencies: DAE-28. Origin: original (DAE-30).

Integrate hardware-specific transport and precision position capabilities.

Acceptance: Unsupported hardware reports unsupported capability instead of fabricated precision.

Gate: Actual field evidence for hardware/production claims.

## DAE-31 — Scale, resilience and contract qualification

Dependencies: DAE-23, DAE-25, DAE-26, DAE-27, DAE-28. Origin: original (DAE-31).

Exercise core boundaries, load, interoperability and failure recovery.

Acceptance: Actual test limits, failures and applicable compatibility evidence are recorded.

Gate: Actual field evidence for hardware/production claims.

## DAE-32 — Engine stable release and maintainer kit

Dependencies: DAE-31. Origin: original (DAE-32).

Package stable contracts, reproducible artifacts and maintenance documentation.

Acceptance: Release source, independent approvals and conformance evidence match the delivered version.

Gate: Actual field evidence for hardware/production claims.

## DAE-33 — Endpoint-encrypted chunked media and private manifests

Dependencies: DAE-01. Origin: added.

Implement attachment-chunked-aead@0.1.0 with fresh per-object keys, exact nonce/AAD binding and authenticated private manifests passed only through an authorized E2EE channel. Endpoint-only plaintext derivatives.

Acceptance: Tamper, reorder, truncate, cross-object substitution, wrong key and malformed manifest tests reject before plaintext release. Known AES-GCM vectors plus portable endpoint round trips.

Gate: Independent crypto/interoperability review before production.

## DAE-34 — Authenticated controls and replay-safe authority

Dependencies: DAE-01. Origin: added.

Ed25519 signed scoped controls, pinned endpoint authorizers, monotonic sequence/epoch, expiry and cancellation. No unsigned fallback; key distribution remains separate from signatures.

Acceptance: Reject forged, stale, expired, cross-app and cross-tenant commands; mutation does not advance checkpoint. Authentication precedes control execution.

Gate: Independent security review before production.

