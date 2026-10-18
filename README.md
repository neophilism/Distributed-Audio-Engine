# Distributed Audio Engine

**Run the integrated software rehearsal:** [docs/rehearsal.md](docs/rehearsal.md). After installing the two locked dependency sets on Linux, `npm run rehearsal` runs core, Signal, TLS relay, crash recovery and production-C rendering tests together and writes a checksummed report. No API key is needed for the isolated rehearsal. This is not a mobile app or a deployed service.

**Development and handoff plan:** [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md).

Neutral TypeScript audio foundation for SceneSignal and Distributed Radio Engine. TrackZero is a consumer of the radio engine. [Architecture](docs/architecture.md) · [Development plan](docs/distributed-audio-engine-development-plan.md) · [Four-project roadmap](docs/roadmap.json)

`npm ci --ignore-scripts` then `npm run check` runs strict typecheck, source/boundary checks, dependency validation, build and tests. Node 24.19.0 and exact development dependencies are pinned; the runtime library has no third-party dependencies.

An optional [bounded encrypted live PCM segmenter](docs/live-input.md) with [receiver continuity checking](docs/live-continuity.md) and [bounded notice reordering](docs/live-reorder.md) now prepares foreground endpoint-supplied capture blocks as fresh encrypted, sequenced media assets. It does not operate a microphone, add network transport, or qualify seamless live playback.

The portable implementation includes encrypted range delivery, a current-position program player, bounded browser audio plus Android and iOS host-binding sinks, shared-clock estimation, signed local coordinator failover, ciphertext cache and durable SQLite replay/cache adapters. It also includes challenged output-evidence primitives, complete-product checkout, payment reconciliation and generic entitlements with private SQLite business stores. [Implementation/evidence status](docs/implementation-status.md) · [Developer guide](docs/developer-guide.md) · [Portable pipeline evidence](docs/portable-integration.md)

Import portable APIs from `@neophilism/distributed-audio-engine`, Web Audio from `/browser`, the Android host binding from `/android`, the iOS host binding from `/ios` and SQLite adapters from `/node`; output evidence and lifecycle contracts have `/evidence` and `/output-lifecycle` entries. CI checks 200 TypeScript tests, separate Node/browser consumer types and an offline packed installation. This remains a development package. Foreground Android AudioTrack/JNI and iOS AVAudioEngine/Swift hosts now have separate native builds and tests; the system JavaScriptCore audio bridge is implemented for iOS. Complete mobile endpoint runtime wiring, acoustic qualification and mobile parent key-channel bindings remain pending.

Protected content is encrypted at authorized endpoints. Server-side transcoding, private-manifest indexing and relay-held media keys are prohibited. [Security boundary and release gates](docs/security.md).

This repository delivers reusable modules and adapters first. Merged software, deployed services, integrated native clients, field measurements and independently reviewed releases are separate milestones. Roadmap IDs differ from GitHub PR numbers.

## End-to-End Everywhere progress

The canonical [security/e2eesa-status.json](security/e2eesa-status.json) records standard implementation, complete testing and independent expert review separately. Engine Room reads it automatically from GitHub. All initial stages are pending; existing profile locks and approved decisions remain authoritative. Read [adoption and independent-account instructions](docs/E2EESA_ADOPTION.md), and run `python3 scripts/validate_e2eesa_status.py`. Record validation does not establish product security or certification.

Native endpoint implementation and remaining platform gates are tracked in [native/README.md](native/README.md). The shared C PCM kernel has separate contract, concurrency and sanitizer checks. See the [Android library](native/android/README.md), [iOS Swift package](native/ios/README.md), and [current native implementation evidence](registry/native-implementation.json). Neither mobile host currently continues playback after foreground loss or lock screen.

Use [owned playback sessions](docs/playback-session.md) to coordinate signed authority, encrypted delivery and native lifecycle invalidation. Complete mobile runtime and parent-protocol bindings remain pending; the separate Node integration below supplies the implemented endpoint channel.

A separate [Node Signal parent adapter](integrations/signal-parent/README.md) now delivers private manifests and controls with actual upstream key exchange, root-verified peers and encrypted atomic endpoint state. Its mobile bindings and independent profile review remain pending; the portable core gains no third-party runtime dependency.

The [TLS ciphertext relay](services/ciphertext-relay/README.md) provides persistent public-key, private-message ciphertext and encrypted audio-chunk delivery for Node endpoints. Network integration tests now traverse real TLS sockets through to C rendering. It is a runnable service with explicit operator configuration, not an existing deployment or mobile release.

The [atomic endpoint journal](docs/endpoint-journal.md) persists outbound ciphertext,
signed encrypted controls and authenticated inbound envelopes together with Signal
ratchet state. Stable IDs, current membership, bounded retention and completed
tombstones support safe explicit retries after restart. The [relay recovery composition](docs/endpoint-relay-recovery.md) acknowledges only
after durable intake and explicitly restores private manifests with persisted
anti-rollback state. It never automatically starts playback or supplies exactly-once
application effects.
