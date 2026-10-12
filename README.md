# Distributed Audio Engine

**Development and handoff plan:** [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md).

Neutral TypeScript audio foundation for SceneSignal and Distributed Radio Engine. TrackZero is a consumer of the radio engine. [Architecture](docs/architecture.md) · [Development plan](docs/distributed-audio-engine-development-plan.md) · [Four-project roadmap](docs/roadmap.json)

`npm ci --ignore-scripts` then `npm run check` runs strict typecheck, source/boundary checks, dependency validation, build and tests. Node 24.19.0 and exact development dependencies are pinned; the runtime library has no third-party dependencies.

The portable implementation includes encrypted range delivery, a current-position program player, bounded browser audio plus Android and iOS host-binding sinks, shared-clock estimation, signed local coordinator failover, ciphertext cache and durable SQLite replay/cache adapters. It also includes challenged output-evidence primitives, complete-product checkout, payment reconciliation and generic entitlements with private SQLite business stores. [Implementation/evidence status](docs/implementation-status.md) · [Developer guide](docs/developer-guide.md) · [Portable pipeline evidence](docs/portable-integration.md)

Import portable APIs from `@neophilism/distributed-audio-engine`, Web Audio from `/browser`, the Android host binding from `/android`, the iOS host binding from `/ios` and SQLite adapters from `/node`; output evidence and lifecycle contracts have `/evidence` and `/output-lifecycle` entries. CI checks 168 TypeScript tests, separate Node/browser consumer types and an offline packed installation. This remains a development package. Foreground Android AudioTrack/JNI and iOS AVAudioEngine/Swift hosts now have separate native builds and tests; consuming-app runtime wiring, acoustic qualification and the authenticated parent key channel remain pending.

Protected content is encrypted at authorized endpoints. Server-side transcoding, private-manifest indexing and relay-held media keys are prohibited. [Security boundary and release gates](docs/security.md).

This repository delivers reusable modules and adapters first. Merged software, deployed services, integrated native clients, field measurements and independently reviewed releases are separate milestones. Roadmap IDs differ from GitHub PR numbers.

## End-to-End Everywhere progress

The canonical [security/e2eesa-status.json](security/e2eesa-status.json) records standard implementation, complete testing and independent expert review separately. Engine Room reads it automatically from GitHub. All initial stages are pending; existing profile locks and approved decisions remain authoritative. Read [adoption and independent-account instructions](docs/E2EESA_ADOPTION.md), and run `python3 scripts/validate_e2eesa_status.py`. Record validation does not establish product security or certification.

Native endpoint implementation and remaining platform gates are tracked in [native/README.md](native/README.md). The shared C PCM kernel has separate contract, concurrency and sanitizer checks. See the [Android library](native/android/README.md), [iOS Swift package](native/ios/README.md), and [current native implementation evidence](registry/native-implementation.json). Neither mobile host currently continues playback after foreground loss or lock screen.
