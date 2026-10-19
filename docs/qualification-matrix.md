# DAE-31 qualification matrix  software candidate

| Area | Software exercise | Actual observation | Remaining field/production qualification |
|---|---|---|---|
| Native output lifecycle | 1,000 ordered route generations and old-route rejection | Source test added; exact-head CI pending | Physical route-switch and audible stop latency measurements |
| Placement tracking | 1,000 independently bound trackers, replay and staleness rejection | Source test added; exact-head CI pending | UWB/vision accuracy and environmental calibration |
| Ciphertext caching | 1,000 insertions against 32-entry / 640-byte limits | Source test added; exact-head CI pending | Real cache/storage pressure and failure recovery |
| Coordinator transport | 64 simultaneous reads, 65th denied, cancellation on close | Source test added; exact-head CI pending | Actual LAN fault/load tests and hardware fallback delays |
| Security and control | Existing signed-control and endpoint encryption suites | Must review exact-head CI | Independent production security and recovery controls remain distinctly unverified |
| Supported device matrix | No device-hardware coverage in this PR | NOT RUN | Actual Android/iOS devices, radios and speaker models |
| Continuous six-hour soak | No real-device soak in this PR | NOT RUN | Six-hour qualified-device tests with recorded errors, thermals and interruptions |

These cases are deterministic in-process contract exercises. Do not use their numeric fixture counts as throughput, maximum scale, synchronization accuracy or compatibility claims. Failures must be recorded from exact-head CI and fixed before a merge. Production/field gates require separate evidence.
