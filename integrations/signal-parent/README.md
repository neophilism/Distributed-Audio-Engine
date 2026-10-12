# Signal parent channel (implementation in progress)

This separate endpoint-only integration pins the maintained upstream
`@signalapp/libsignal-client` at 0.105.0. It does not add a dependency to the
portable audio core. The native library is AGPL-3.0-only and Signal explicitly
does not support third-party use; retain its notices, review distribution
obligations, and do not claim upstream support or independent certification.

The current branch is establishing reproducible dependency/build evidence. Do
not merge until the actual adapter, durable state boundary, authenticated identity
binding, media/control integration and adversarial tests are implemented and the
exact-head checks pass. No production activation, credentials or deployed service
are supplied by this dependency bootstrap.
