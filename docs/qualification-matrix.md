# DAE-31 qualification matrix — software candidate

| Area | Software exercise | Actual observation | Remaining field/production qualification |
|---|---|---|---|
| Native output lifecycle | 1,000 ordered route generations and old-route rejection | Targeted local tests passed on Node 24.22.1; updated-head hosted CI not yet observed | Physical route-switch and audible stop latency measurements |
| Placement tracking | 1,000 independently bound trackers, replay and staleness rejection | Targeted local tests passed on Node 24.22.1; updated-head hosted CI not yet observed | UWB/vision accuracy and environmental calibration |
| Ciphertext caching | 1,000 insertions against 32-entry / 640-byte limits | Targeted local tests passed on Node 24.22.1; updated-head hosted CI not yet observed | Real cache/storage pressure and failure recovery |
| Coordinator transport | 64 simultaneous reads, 65th denied, cancellation on close | Targeted local tests passed on Node 24.22.1; updated-head hosted CI not yet observed | Actual LAN fault/load tests and hardware fallback delays |
| Cache invalidation recovery | 64 shared readers, late completion, overlapping invalidations and injected upstream failure | Three targeted regression tests passed locally; updated-head hosted CI not yet observed | Durable network/storage failure injection remains separate |
| Security and control | Existing signed-control and endpoint encryption suites | Existing-head CI passed; new-head CI must be reconciled | Independent production security and recovery controls remain distinctly unverified |
| Supported device matrix | No device-hardware coverage in this PR | NOT RUN | Actual Android/iOS devices, radios and speaker models |
| Continuous six-hour soak | No real-device soak in this PR | NOT RUN | Six-hour qualified-device tests with recorded errors, thermals and interruptions |

These cases are deterministic in-process contract exercises. Do not use their numeric fixture counts as throughput, maximum scale, synchronization accuracy or compatibility claims. Failures must be recorded from exact-head CI and fixed before a merge. Production/field gates require separate evidence.

The cache invalidation regressions require all shared readers to reject, forbid late ciphertext repopulation, and reject new reads while upstream invalidation remains unresolved. These fixtures measure state transitions, not a throughput or durability benchmark. A failed upstream invalidation is reported and the caller may retry; no upstream deletion success is inferred from local cache eviction.

