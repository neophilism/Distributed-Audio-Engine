# Using the portable audio core

The library currently builds against Node 24.19.0 using TypeScript 7.0.2. Public exports are in `src/index.ts` with declarations in `dist/src/index.d.ts`. It has no third-party runtime dependencies. Run `npm ci --ignore-scripts` and `npm run check`.

## Endpoint media flow

1. At the authorized creator/operator endpoint, decode supported RIFF/WAVE PCM and check all required rights layers/uses.
2. Use `packageRendition` to create sample-aligned metadata and a fresh encrypted rendition. Metadata, private manifest and attachment keys stay at the endpoint.
3. Upload only ciphertext chunks through `IngestionManager` and a storage adapter. Its public upload schema excludes private manifests; incomplete objects stay quarantined.
4. Deliver the manifest/key through an authenticated E2EESA parent channel to explicitly authorized listening endpoints. That channel is an integration prerequisite, not a URL key or plaintext JSON fallback.
5. At the listener endpoint, use `decryptAttachment` with the expected tenant/application/parent context, then decode/render only authenticated media.

The convenience attachment codec handles bounded objects (64 MiB default, explicitly configurable up to 1 GiB); long recordings should be segmented or use the later streaming/range adapter. Keys/manifests must never enter service logs or object metadata. Memory stores are reference adapters, not crash-durable deployment storage.

## Timeline and spatial flow

`compileProgram` and `ProgramTimeline` give a canonical sample clock, exact clip/loop positions and transition markers. Clock/network alignment does not imply calibrated speaker-emission alignment. Native sinks and route-specific timing remain next-stage work.

`validateScene`, `createMixPlan` and `renderSpatialChunk` produce position-dependent mono PCM mixtures using capability weights and output ceilings. Each source's normalized electrical mixing weights keep additional speaker density from arbitrarily multiplying that source's contribution. These weights do not assert that the physical shared sound field has no interference or perfect instrument isolation.

`PlacementRegistry` separates fixed placements from object-specific tracking. SceneSignal calls its physical instrument anchors Spimes; the audio core names them generically. Tracked coordinates require a bound tracker, appropriate method, freshness and confidence. A participant's phone never silently becomes the position of a fixed speaker or a different object.

`ControlVerifier` authenticates scoped signed controls and uses an atomic checkpoint interface. `PlaybackAuthority` consumes those controls and a separately authenticated E2EE payload decoder to enforce leases, consent ceilings, fade/stop deadlines and supersession. Persist replay checkpoints before deployment. The client must continue checking authority even if its network connection disappears.

## Dependencies still requiring integration

Native Android/iOS audio and measurement adapters; actual E2EESA pairwise/group key distribution; authenticated root/recovery storage; durable SQL/object-store/checkpoint adapters; compressed-media/resampling adapters; deployed retention/restore drills; local coordination/cache and commerce adapters; full acoustic evidence integration; physical-device trials; independent release review and client-update assurance.

Keep work moving through these separately recorded packages. Nothing in a portable unit test supplies independent field evidence or an upstream certification claim.
