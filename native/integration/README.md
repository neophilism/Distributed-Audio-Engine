# Signed endpoint-to-native software integration

This harness joins the actual portable control verifier, playback authority,
endpoint session, media package/decryption, current-position player, both native
sink contracts, and production `native/core/dae_pcm.c` in one process. It checks
rendered samples rather than stopping at a recorded enqueue call.

Run from the repository root after installing the pinned development dependencies:

```sh
npm run build
sh native/integration/test.sh
```

The script builds a temporary Linux Node-API test adapter with a C11 compiler and
undefined-behavior sanitizer, runs 17 Node tests, then removes the binary. It needs
Node development headers at the installed runtime's `include/node`; a distribution
with separate headers can explicitly set `NODE_INCLUDE_DIR`. No dependency install,
network request, secret or physical device is used by the script. Hosted Engine CI
runs it with the pinned Node runtime after the complete portable check and audit,
before retaining development artifacts. Separate native CI still runs the core's
ASan/UBSan, concurrency and adversarial tests and actual Android/iOS builds.

## What is exercised

For each native sink contract, a real Ed25519-signed lease, encrypted lease payload,
and AES-GCM-packaged WAV pass through the session into actual native-owned PCM and
C rendering. Tests verify expected stereo samples after JavaScript temporary PCM
has been wiped, gain contraction on renewal, fades and hard stops with no further
JavaScript pumping, recipient expiry, rejected controls/corrupt payload/media,
rights revocation, emergency cancellation, explicit reconnect and stale events.
The adapter additionally rejects malformed, shared or detached buffers, invalid
render bounds, non-handle values and operations after an idempotent close.

The native test adapter allocates output on the test thread. That allocation is
not in the production audio callback and does not establish real-time scheduling
or CPU/latency performance. A rejected callback's output must be silence. The
same kernel is compiled directly from the production source, not a reimplementation.

## What is not established

This is not Android AudioTrack, iOS AVAudioEngine, a mobile JavaScript runtime,
physical sound, a speaker measurement, LAN discovery, or a production deployment.
Routes, clocks and manifest resolution are local test fixtures. The lease payload
uses a fresh locally provisioned AES test key only to exercise authenticated
payload rejection. It is **not** key agreement, an approved pairwise/group parent
protocol, forward secrecy, post-compromise security or recipient provisioning.

`pcm_addon.c` and `KernelBridge` are deliberately test-only and are not part of the
published npm file allowlist. Applications must supply the separately qualified
in-process mobile bridge, authenticated parent/key channel and protected replay
state. A passing test here does not promote any mobile, field, E2EESA-review or
stable-release milestone. No private media keys, PCM or real user data are written
by this harness; all content is generated test data held in process memory.
