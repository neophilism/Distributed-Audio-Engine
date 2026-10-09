# Portable engine integration evidence

The software pipeline now composes authenticated shared-clock estimates, ordered signed controls, expiring playback authority, endpoint rights decisions, canonical linear timelines, opaque local/fallback transports, ciphertext cache, complete-file decryption, private media metadata and PCM scheduling. The integration fixture uses real Web Crypto encryption/signatures and real SQLite cache/checkpoint adapters. Its parent/control E2EE decoder, clock reference and PCM output are explicit test adapters; it supplies no native or physical-output evidence.

The pipeline tests exercise current-frame joining, reuse of a bounded decoded asset, a broadcaster-defined next asset, host-loss fallback, scope/metadata confidentiality at transport boundaries, rights revocation, emergency authority loss and corrupt-local-chunk rejection. Failed authentication clears the poisoned cache and schedules no PCM; after discarding the failed host, the trusted ciphertext fallback can deliver the authenticated asset. This preserves the security boundary during availability recovery.

Additional hardening makes cache closure settle callers even when an upstream ignores abort, cancels rejected HTTP response bodies, fails fast on mismatched control-verifier scope and drops copied raw media key strings after decoding. JavaScript cleanup cannot promise immediate erasure of prior copies.

The package now separates three entry points:

| Import | Purpose | Consumer type environment |
|---|---|---|
| `@neophilism/distributed-audio-engine` | Portable contracts, cryptography, media, timing, policies and player | Node without DOM, or browser DOM |
| `@neophilism/distributed-audio-engine/browser` | Web Audio sink | Browser DOM; no Node ambient types required |
| `@neophilism/distributed-audio-engine/node` | SQLite cache/checkpoint adapters | Node 24 |

Public key types refer to the platform's actual Web Crypto key class in either environment. Type checks exercise consumers independently, and package verification builds a real tarball, installs it offline into an isolated temporary consumer and exercises the exported encryption/timeline/storage APIs. Package contents exclude tests, dependencies, database files and environment files. Temporary verification artifacts are removed; no registry publication or deployment occurs.

The core remains a development library, not the stable DAE-32 release. DAE-11 has a portable reference implementation with native/acoustic prerequisites still pending. Android/iOS output lifecycle, secure key distribution/recovery/storage, hardware latency/level/attribution profiles, durable ingestion state, deployed recovery/retention, independent release review and the remaining commerce/entitlement modules are not supplied by this integration evidence.
