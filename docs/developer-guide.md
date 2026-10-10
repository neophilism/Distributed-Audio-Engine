# Using the portable audio core

The library builds against Node 24.19.0 using TypeScript 7.0.2. Portable exports are in `src/index.ts`, browser audio in the `/browser` subpath and SQLite adapters in `/node`, each with emitted declarations. It has no third-party runtime dependencies. Run `npm ci --ignore-scripts` and `npm run check`; this also verifies separate consumer types and a packed offline installation.

## Endpoint media flow

1. At the authorized creator/operator endpoint, decode supported RIFF/WAVE PCM and check all required rights layers/uses.
2. Use `packageRendition` to create sample-aligned metadata and a fresh encrypted rendition. Metadata, private manifest and attachment keys stay at the endpoint.
3. Upload only ciphertext chunks through `IngestionManager` and a storage adapter. Its public upload schema excludes private manifests; incomplete objects stay quarantined.
4. Deliver the manifest/key through an authenticated E2EESA parent channel to explicitly authorized listening endpoints. That channel is an integration prerequisite, not a URL key or plaintext JSON fallback.
5. At the listener endpoint, use `decryptAttachment`, or `EndpointAttachmentReader` with `readAttachmentRange`, with the expected tenant/application/parent context. Partial ranges authenticate required chunks; complete reads also verify the file hash. Decode/render only authenticated media.

The attachment codec handles bounded objects (64 MiB default, configurable up to 1 GiB). Range reads are capped to 64 MiB per call; long recordings should be separate bounded segments. Keys/manifests must never enter service logs or object metadata. Memory stores are reference adapters. Node SQLite cache/checkpoint adapters provide tested local persistence, with deployed retention/rollback/recovery qualification still pending.

`EndpointProgramPlayer` follows the programmed timeline, rechecks expiring endpoint rights and resolves the current target after asynchronous delivery. It retains one bounded decoded asset locally and wipes it on replacement/interruption. It supplies PCM fragments to a sink, including `BrowserAudioSink` from the browser entry point. Review the [player](program-player.md), [browser lifecycle limits](browser-playback.md) and [delivery contract](encrypted-delivery.md) before integration.

`AndroidAudioSink` from `/android` binds the same player and signed authority to a trusted Android host. The host must source active routes from AudioManager, copy bounded PCM synchronously into AudioTrack-owned storage, enforce monotonic fade/stop deadlines and report focus/lifecycle/output changes. Review the [Android host contract](android-playback.md). Portable bridge tests are not real-device qualification.

`IOSAudioSink` from `/ios` applies the same fail-closed boundary to an AVAudioSession/AVAudioEngine host. The host supplies current-route generations, copies PCM before return, enforces host-time deadlines and reports interruptions, route loss, media-services resets and engine state. Review the [iOS host contract](ios-playback.md). Host-double tests do not qualify a device.

## Timeline and spatial flow

`compileProgram` and `ProgramTimeline` give a canonical sample clock, exact clip/loop positions and transition markers. Clock/network alignment does not imply calibrated speaker-emission alignment. Native sinks and route-specific timing remain next-stage work.

`validateScene`, `createMixPlan` and `renderSpatialChunk` produce position-dependent mono PCM mixtures using capability weights and output ceilings. Each source's normalized electrical mixing weights keep additional speaker density from arbitrarily multiplying that source's contribution. These weights do not assert that the physical shared sound field has no interference or perfect instrument isolation.

`PlacementRegistry` separates fixed placements from object-specific tracking. SceneSignal calls its physical instrument anchors Spimes; the audio core names them generically. Tracked coordinates require a bound tracker, appropriate method, freshness and confidence. A participant's phone never silently becomes the position of a fixed speaker or a different object.

`ControlVerifier` authenticates scoped signed controls and uses an atomic checkpoint interface. `PlaybackAuthority` consumes those controls and a separately authenticated E2EE payload decoder to enforce leases, consent ceilings, fade/stop deadlines and supersession. Persist replay checkpoints before deployment. The client must continue checking authority even if its network connection disappears.

`DisciplinedClock` can supply a common time adapter from challenged authenticated reference timestamps. It rejects stale/uncertain/conflicting estimates and requires explicit stop/reset/rejoin for unsupported corrections. Network-clock estimates never qualify acoustic output.

`CoordinatorMonitor` accepts primary-signed program/scoped leases, and `CoordinatorChunkTransport` uses configured local ciphertext transports with bounded fallback. `CachingChunkTransport` and `EndpointCiphertextCache` cache only opaque ciphertext. Local hosts/caches never acquire keys or playback authority; the same canonical timeline drives either transport path.

## Output evidence and authorized business facts

The `/evidence` and `/output-lifecycle` entries supply partial portable route/measurement foundations. Qualified intervals require challenged authenticated verifier decisions, whole-window calibration and conservative clock/level bands. Endpoint-local immutable receipts cannot be reconstructed from a JSON qualification flag. See [output evidence](output-evidence.md).

`CheckoutEngine`, `ReconciliationEngine` and `EntitlementLedger` are portable core APIs. SQLite purchase/accounting/entitlement stores are in `/node`. They process intentionally authorized opaque business facts; they never store or transmit media keys or private manifests. A settled purchase or entitlement does not by itself authorize a recipient key delivery. Read [commerce](commerce.md), [entitlements](entitlements.md) and the [component/data-flow inventory](security-flow-inventory.json) before integration.

## Dependencies still requiring integration

Real Android AudioManager/AudioTrack and iOS AVAudioSession/AVAudioEngine hosts plus device qualification; native measurement/secure-state adapters; actual E2EESA pairwise/group key distribution and control channels; authenticated root/recovery storage; durable upload state/object-store adapters; compressed-media/resampling adapters; deployed retention/restore drills and LAN provisioning; actual signed payment-provider/dispatch adapters and complete-product/refund fulfillment; full acoustic evidence integration; physical-device trials; independent release review and client-update assurance.

Keep work moving through these separately recorded packages. Nothing in a portable unit test supplies independent field evidence or an upstream certification claim.
