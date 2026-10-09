# Distributed Audio Engine

Neutral TypeScript audio foundation for SceneSignal and Distributed Radio Engine. TrackZero is a consumer of the radio engine. [Architecture](docs/architecture.md) · [Development plan](docs/distributed-audio-engine-development-plan.md) · [Four-project roadmap](docs/roadmap.json)

`npm ci --ignore-scripts` then `npm run check` runs strict typecheck, source/boundary checks, dependency validation, build and tests. Node 24.19.0 and exact development dependencies are pinned; the runtime library has no third-party dependencies.

Protected content is encrypted at authorized endpoints. Server-side transcoding, private-manifest indexing and relay-held media keys are prohibited. [Security boundary and release gates](docs/security.md).

This repository delivers reusable modules and adapters first. Merged software, deployed services, integrated native clients, field measurements and independently reviewed releases are separate milestones. Roadmap IDs differ from GitHub PR numbers.
