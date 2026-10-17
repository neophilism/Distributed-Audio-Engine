# Mobile endpoint integration contract (development)

This is the implementation boundary for the **foreground** Android AudioTrack/JNI and iOS AVAudioEngine/JavaScriptCore paths. It is not a device qualification, cryptographic certification, production deployment, or a claim of audible output timing.

## Application-owned end-to-end path

1. The installed application bootstraps a trusted, bundled endpoint runtime. Never evaluate remote JavaScript or attach a native PCM interface to an untrusted WebView origin/frame.
2. Use an upstream-compatible, authenticated E2EE parent channel and encrypted atomic endpoint state. Verify root-pinned device enrollment, revocation, scope, replay sequence and expiry **before** granting any local audio authority. The ciphertext-only relay must never receive media plaintext, attachment keys or private manifests.
3. Receive a private rendition manifest via authenticated E2EE, fetch bounded ciphertext chunks over TLS, authenticate/decrypt at the recipient endpoint, and verify media rights before scheduling. Never silently substitute transport TLS for E2EE.
4. Compose signed control leases and explicit emergency stop with the current native output lifecycle. Route generations, epoch/sequence and bounded lease deadlines remain authoritative. Neither a route callback nor a clock response can mint playback permission.
5. Perform explicit endpoint-side sample-rate conversion and channel rendition selection before enqueue. The Android and iOS hosts require an exact active native layout; no relay transcoding or implicit native stereo upmix is allowed.
6. The host may announce a route only after its platform output state is actually active. Native completion means queued-buffer ownership ended, **not** that sound was heard. A route type, Bluetooth class or accessory name is not acoustic evidence.
7. On focus loss, interruption, app suspension, stale generation, route change, failed native callback, clock rollback or revoked membership: revoke signed playback authority, cancel/flush native output as available, discard pending PCM and require an explicit fresh user-controlled rejoin. Queued OS/hardware buffers cannot be physically recalled by software.

## Android consumption

The AAR is a Java 17 Android library (min API 26). Construct `AndroidAudioHost` from the foreground owning Activity on the main thread, subscribe to typed `Event`, then start only on an explicit user playback action. Keep JavaScript-to-Java transport in the trusted application (e.g. a reviewed in-process typed binding); do not expose `@JavascriptInterface` to arbitrary web content. Schedule `NativePcm.Request` synchronously with native-owned PCM copying; immediately clear temporary buffers. Sample the host using `AndroidAudioHost.nowMonotonicMs()` and do not confuse it with Unix/elapsedRealtime. Map event payloads to the exact TypeScript union, never a JSON serialization of all nullable Java fields.

## iOS consumption

Embed the `JavaScriptCoreAudioBridge` in a trusted, bundled application JSContext on the main actor. Use `IOSAudioHost.nowHostTimeMs()` and the same native clock domain throughout the portable sink call. The bridge validates typed-array bounds, copies PCM and closes the host on malformed calls; it does **not** implement module loading, WebCrypto, Signal enrollment or authenticated media delivery. Do not install a fake cryptographic polyfill or remotely fetched runtime code as a replacement.

## Exact source and verification

The portable TypeScript contract tests, pinned real Signal integration tests, actual TLS ciphertext relay, signed media-to-C integration, Android Java/JNI/C tests, actual Android AAR build/lint, Swift/C tests and unsigned iOS simulator compile are separate software gates. Treat results as passed only when the GitHub workflow conclusion is `success` for the **exact PR head SHA**; queued, pending, cancelled, failed or older-head runs do not qualify. No field, microphone, route-latency, device-soak, physically audible stop or certification claim follows from these jobs.

Before integrating with Distributed Radio Engine, SceneSignal or TrackZero, the consuming runtime still needs trusted application packaging, real mobile E2EE bindings and protected revision floors, device enrollment/recovery, permissions/OS lifecycle tests, monitored relay deployment, field calibration/route matrix and six-hour supported-device soaks. Publish each unresolved gate with explicit `pending` status; do not infer `passed` from an absent result.

See `AGENTS.md`, `docs/implementation-status.md`, `docs/E2EESA_ADOPTION.md`, `native/android/README.md` and `native/ios/javascriptcore.md`.
