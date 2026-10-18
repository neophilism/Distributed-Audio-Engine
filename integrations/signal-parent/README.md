# Authenticated Signal parent channel

An implemented **Node endpoint integration**, separate from the dependency-free
portable engine. It uses the maintained `@signalapp/libsignal-client` **0.105.0**
native library for prekey establishment and ratcheting. There is no home-grown
key agreement, JSON-to-plaintext fallback, relay-held media key, or TLS-only
substitute. The exact transitive dependencies and archive integrity are locked in
`package-lock.json`. The upstream source reference is `signalapp/libsignal`, tag
`v0.105.0`; its public Java/Swift/Node APIs, not its internal bridge, are the basis.

This package must run at the creator/listener endpoint, never on a ciphertext
relay. Its Node library is not an Android or iOS executable. Mobile bindings to
the same upstream protocol, hardware-backed state, independent profile review,
physical outputs and production operations remain separate gates.

## Explicit encrypted clock-probe round trip

`queueSignalClockProbe({ channel, recipient, clock, messageId, expiresAtMs })`
starts `DisciplinedClock.beginProbe()` at the caller's monotonic time and queues
the fresh nonce as a durable encrypted `ack` message to an authorized peer. The
caller must flush and pull the existing Signal relay endpoint explicitly.
On the reference endpoint, pass **only** a retained, authenticated
`SignalParentChannel.receivePacket` inbox receipt to
`respondSignalClockProbe({ channel, controller, receipt, receivedUnixMs,
uncertaintyMs, nowUnixMs })`. The responder rechecks the durable inbox before
issuing the signed encrypted clock response, uses the caller-supplied trusted
reference timestamp and uncertainty, and resumes identical ciphertext on
duplicate receipt. It does not automatically mark the probe consumed or send
the response; the application owns relay flush/ack/completion and expiration.
Never invoke the responder with unsigned relay JSON.

These explicit helpers do **not** establish an accurate trusted reference clock,
a physically measured output delay, hardware support, or a background scheduler.
Restarting a failed probe may supersede the receiver's old nonce; an unbounded
or stale response must not be treated as a time source.

## Authenticated clock responses (Node endpoints)

The existing endpoint Signal channel now accepts `clock-response` as an
Ed25519-signed, libsignal-encrypted control with a **durable controller intent**
and identical-ciphertext retry. The recipient uses
`SignalPlaybackInbox.createClockVerifier(vault)` and
`DisciplinedClock` (portable engine) with
`inbox.decodeControlPayload`. Clock and playback verifiers share one encrypted
scope checkpoint; process controls in exactly the issued epoch/sequence order.
A missing control cannot be skipped without explicit epoch reconciliation.

The response contains a fresh 64-character lowercase hex probe nonce,
bounded receive/send Unix timestamps, and stated reference uncertainty. The
issue-to-expiry window is at most five seconds, and timestamps must be recent
and monotonic. Authentication proves sender identity, **not** clock accuracy,
audible output, device calibration or field synchronization. The client still
owns the trusted clock reference, local monotonic probe capture, challenge
delivery, hardware state, network operation and native app integration.
The ciphertext relay never receives a response's private timestamps or nonce.

`tests/clock-response.test.mjs` exercises the actual signed/ratcheted,
crash-resumable Node path through `DisciplinedClock`, shared replay checkpoints,
malformed controls and revoked membership. This is integration software
evidence, not a phone or speaker test.

## Build and verification

From the repository root, with the pinned Node runtime:

```sh
npm ci --ignore-scripts
npm run build
npm ci --ignore-scripts --prefix integrations/signal-parent
npm run typecheck --prefix integrations/signal-parent
npm test --prefix integrations/signal-parent
sh integrations/signal-parent/test-native.sh
```

There are **31 endpoint/storage/playback tests** and **10 additional native
integration cases**. The latter use the real maintained Signal library, root-signed
device enrollment, encrypted file state, private manifest delivery, signed private
controls, the owned playback session and production C sample rendering. Only
routes, clocks, audio content and local rights policy are fixtures. The tests do
not pre-share media keys between endpoints or substitute a fake parent decoder.
Native routes are still synthetic: these tests are not physical-speaker evidence.

## Endpoint lifecycle

1. Obtain a device-local 32-byte vault key from the application's approved secret
   store. Create a real, owner-private absolute directory (0700). Initialize
   `EncryptedFileVault` with an endpoint-specific binding and, on restore/reopen,
   the independently retained minimum revision. Never put its key in a relay,
   public environment variable, log, source tree or sibling endpoint's vault.
2. Call `initializeSignalIdentity` **explicitly once**. It returns only the public
   signing/agreement descriptor. Enroll that descriptor in `DeviceRegistry` with
   a valid account-root-signed event. Missing or corrupt persisted state never
   triggers automatic identity recreation or automatic trust replacement.
3. Construct `SignalParentChannel` with that verified registry. Authorize each
   peer explicitly using a locally trusted root-verified registry, device ID,
   allowed send/receive kinds and an expiry. There is no trust-on-first-use,
   wildcard permission or remote self-enrollment operation.
4. Deliver the recipient's `publicBundle()` over any suitable public-key directory
   or transport. `connect(peerAddress, bundle)` verifies the enrolled identity,
   full public bundle signature, scope, expiry and upstream prekey signatures.
   EC and KEM prekeys are one-time, bounded and consumed atomically with receiving
   session state. The native library performs the protocol itself.
5. Use `seal`/`receive` for `manifest`, `control` or `ack` messages. Each encrypted
   envelope binds its protocol, exact tenant/application/session, sender,
   recipient, kind, message ID and lifetime. Outer records contain only routing,
   protocol/type metadata and ciphertext. A relay cannot approve a new recipient.
6. Use `SignalPlaybackInbox` and `createSignalControl` for audio. The inbox supplies
   the existing private-manifest resolver and control-payload decoder. Its
   `sessionOptions` also provides a membership-aware signed-control verifier and
   wraps the application's current rights check. Thus cached PCM does not bypass
   sender rotation/revocation on a later pump. Feed these options and an actual
   native bridge to `EndpointPlaybackSession.android` or `.ios`.

The existing root event and application rights APIs remain authoritative. Trust
anchors and permissions must come from the endpoint's approved onboarding path,
not a registry constructed from an untrusted network response. Revocation events
should stop the session immediately; pumping also checks membership. Native
signed deadlines still bound output when JavaScript is suspended.

## Media and control binding

The creator packages media with the existing endpoint attachment codec, then
seals its complete `EndpointMediaAsset` descriptor as kind `manifest`. Set the
parent message ID to `descriptor.context.parentMessageId`; the inbox requires that
exact binding. It validates the private manifest and retains at most eight current
descriptors in volatile endpoint memory. It never writes media keys to the relay.

`createSignalControl(channel, recipient, fields, policy)` takes fields `epoch`,
`sequence`, `issuedAtMs`, `expiresAtMs`, and action `lease` or `emergency-stop`.
It encrypts the exact control header and policy with Signal, then applies the
existing independent DAE signature to that ciphertext. The decoder compares the
inner and outer headers. A valid outer signature cannot substitute an unrelated
encrypted payload. The verifier rechecks root-authorized membership even for
emergency-stop operations, which the authority class does not decrypt.

Use ordered control delivery and the existing exact-sequence checkpoints. The
adapter does not invent an epoch after packet loss. Signal can handle legitimate
out-of-order ratchet messages, but that is not permission to reorder DAE commands.
A duplicate ciphertext cannot release plaintext twice, including after reopening
the encrypted state file. An invalid application payload may consume its valid
Signal ciphertext without producing a playback decision.

## Atomic state and failure boundaries

The encrypted file vault authenticates its complete snapshot and endpoint binding
with AES-256-GCM and a fresh random nonce. It enforces bounded reads, 0600 regular
files, a 0700 real directory, link rejection, exclusive writer locking, atomic
rename and file/directory fsync. A crash leaving the lock requires explicit
recovery; the library never guesses whether the owner is dead. Serialized
libsignal session/prekey changes are committed together **before ciphertext or
plaintext is returned**. Concurrent instances use compare-and-set; a losing
operation withholds its output. Control checkpoints occupy a separate encrypted
row, so they cannot overwrite ratchet updates.

The vault rejects rollback below an observed or supplied revision floor. **That
is not hardware-backed rollback protection:** an attacker able to restore both a
vault and its external floor can defeat this check. The application must retain
its floor in an independently protected monotonic facility and qualify backup,
restore and crash behavior. POSIX mode checks are not a substitute for hardware
key protection. Native/JavaScript objects and filesystem snapshots may retain
historical copies; best-effort buffer clearing is not a secure-erasure guarantee.

A channel admits only one outstanding cryptographic operation. Callers must
serialize their bounded ingress and use transport timeouts. Maximums: 32 peers,
64 outstanding one-time keys, five-minute message/permission lifetimes, 24 KiB
plaintext envelopes, 48 KiB outer wire records and a 1 MiB encrypted vault snapshot.
Requests exceeding limits fail rather than switching protocol or storing plaintext.
There is no group protocol, background reconnect daemon, network service, relay
implementation, microphone capture or payment-provider operation in this package.

## Security and distribution status

This implements the previously absent parent-channel path for Node endpoints.
It is a development integration of upstream Signal's current prekey/ratchet APIs,
not a declaration that every E2EESA pairwise profile requirement is satisfied.
The candidate mapping is `pairwise-pqxdh-triple-ratchet@0.1.0`; interoperability,
exact profile/revision mapping, post-compromise assumptions, secure persistence
and independent review must be assessed before enabling production claims.
No post-quantum authentication or production certification is asserted.

Upstream licenses libsignal **AGPL-3.0-only** and states that third-party use is
unsupported. Preserve its notices and dependency acknowledgments. Distribution
obligations and platform support require review before shipping a combined
application. This repository does not publish a package or signed application.
Neither successful tests nor a dependency audit complete independent review.

See `registry/signal-parent-integration.json`, the pinned security baseline and
the main development plan for source, test scope and remaining release gates.
