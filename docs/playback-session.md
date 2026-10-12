# Owned endpoint playback sessions

`EndpointPlaybackSession.android(...)` and `.ios(...)` compose the existing
signed `PlaybackAuthority`, encrypted `EndpointProgramPlayer`, and native sink.
This is application-side orchestration, not a new messaging/key protocol or a
mobile JavaScript engine. Supply the actual in-process native bridge, a pinned
scoped control verifier with durable replay checkpoints, current endpoint rights,
and an authenticated parent-channel manifest resolver and payload decoder.

```ts
const session = EndpointPlaybackSession.android({
  scope, timeline, resolver, transport, authorizePlayback, controls,
  decodeControlPayload, consentedGainCeiling: 0.5,
  nowUnixMs: () => sharedClock.now(),
  bridge: nativeAndroidBridge,
  native: { nowMonotonicMs: () => nativeAndroidBridge.nowMonotonicMs() },
});
// The application starts the native host on explicit user action and waits for
// its actual route-active event. Then use a newly signed scoped lease:
await session.join(signedLease);
await session.pump(); // repeat while foreground, with bounded scheduling
// Renewal only affects future PCM; already queued envelopes can only contract.
await session.renew(nextSignedLease);
session.stop(); // cancels delivery, wipes cached PCM, revokes the local lease
session.close(); // also unsubscribes/closes the sink; close the owned OS host too
```

The identifiers above are application adapters, not working default credentials,
network endpoints, a fake parent channel, or a complete runnable mobile app.
For iOS use `.ios` and the host's `nowHostTimeMs` clock instead. All clock sources
must meet their existing monotonic/shared-clock contracts.

## State and failure behavior

A route alone never authorizes playback. `join` explicitly starts or rejoins;
`renew` is allowed only while playing. Native route/lifecycle invalidation revokes
the session, aborts in-flight delivery, clears the sample cursor, wipes its cached
PCM and invalidates pending lease operations before any rejoin. Duplicate active
route announcements are idempotent. A stale download or lease completion cannot
restart output or stop a newer generation. The native bridge must synchronously
copy the PCM buffer before returning, as before.

Every pump checks authority and rights, including when the native queue is full.
It retains at most 64 queued asset end times and rechecks every unexpired queued
asset, not only the next timeline target. Revoked or shortened permission cancels
the queue conservatively; expired prior tracks no longer gate unrelated output.
Rights denial cancels the existing queue at the next pump; asynchronous rights or
membership revocation notifications should call `stop` immediately. Queued PCM
is also bounded by the permission/recipient expiry that authorized it. An expired
lease, rollback, invalid signature, replay, delivery failure or native failure
cannot automatically rejoin. User gain zero stops the session; raising gain does
not implicitly restart it. Snapshot fields contain status only, no keys or PCM.

At most one lease and one emergency verification may be pending. An authenticated
emergency stop can supersede a lease already waiting on private payload delivery.
The original exact-sequence verifier still rejects gaps; transport must preserve
control order. Adapter promises cannot be forcibly terminated: a new lease is
rejected as busy until an outstanding decoder settles, even after stop. An
application must bound its adapter network timeouts and handle the rejection.
Normal forward clock progress from pumping does not invalidate a renewal still
being decoded. Its expiry is checked against the latest observed time before
commit and again by the owning session. A superseded or already expired request
cannot rearm output. No internal timer or automatic reconnection is installed.

Native callbacks enforce their own deadlines even when JavaScript is suspended.
The application must close the OS host it owns as well as the session. Driver
stop/flush failures cannot be turned into an assertion that physical sound stopped.
Foreground-only restrictions and actual audible stop-latency measurements remain.

## Evidence and boundaries

`tests/playback-session.test.ts` covers both concrete portable sinks with real
Ed25519 signatures and real AES-GCM packaged audio. Native bridge and parent
payload decoder doubles are explicit. These tests establish session composition,
not actual mobile JS-runtime wiring, parent key distribution, speaker output,
acoustic synchronization, hardware-protected checkpoints or independent review.
The pinned upstream pairwise/group protocol must be integrated separately; no
TLS-only, plaintext JSON, pre-shared-key or custom-ratchet fallback is added here.

A separate [native integration harness](../native/integration/README.md) runs the
same signed-control/encrypted-media session through the production C renderer in
process. Its Node-API adapter is test-only. Its local fixture keys and synthetic
routes do not replace the pending mobile runtime or authenticated parent protocol.
