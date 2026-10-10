# Distributed Audio Engine

**Development and handoff plan:** [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md).

Neutral TypeScript audio foundation for SceneSignal and Distributed Radio Engine. TrackZero is a consumer of the radio engine. [Architecture](docs/architecture.md) · [Development plan](docs/distributed-audio-engine-development-plan.md) · [Four-project roadmap](docs/roadmap.json)

`npm ci --ignore-scripts` then `npm run check` runs strict typecheck, source/boundary checks, dependency validation, build and tests. Node 24.19.0 and exact development dependencies are pinned; the runtime library has no third-party dependencies.

The portable implementation includes encrypted range delivery, a current-position program player, a bounded browser audio sink, shared-clock estimation, signed local coordinator failover, ciphertext cache and durable SQLite replay/cache adapters. It also includes challenged output-evidence primitives, complete-product checkout, payment reconciliation and generic entitlements with private SQLite business stores. [Implementation/evidence status](docs/implementation-status.md) · [Developer guide](docs/developer-guide.md) · [Portable pipeline evidence](docs/portable-integration.md)

Import portable APIs from `@neophilism/distributed-audio-engine`, Web Audio from `/browser` and SQLite adapters from `/node`; output evidence and lifecycle contracts have `/evidence` and `/output-lifecycle` entries. CI checks 139 tests, separate Node/browser consumer types and an offline packed installation. This remains a development package; native/acoustic integration and the authenticated parent key channel are pending.

Protected content is encrypted at authorized endpoints. Server-side transcoding, private-manifest indexing and relay-held media keys are prohibited. [Security boundary and release gates](docs/security.md).

This repository delivers reusable modules and adapters first. Merged software, deployed services, integrated native clients, field measurements and independently reviewed releases are separate milestones. Roadmap IDs differ from GitHub PR numbers.
