# iOS native host (development)

`Package.swift` at the repository root builds `DistributedAudioHost` and the shared
C PCM kernel without external package dependencies. Add this repository at an
exact reviewed commit in Xcode; import `DistributedAudioHost`. This source is not
an App Store release or a signed installable app. No Apple membership or signing
credential is needed for the host's simulator build.

## Implemented path

`IOSAudioHost` owns an AVAudioSession playback session and an AVAudioEngine graph
with an AVAudioSourceNode. The source callback renders the shared native queue at
its supplied host timestamp, deinterleaves bounded float PCM, clears temporary
scratch and reports silence on contention or faults. It never uses a JavaScript
timer for gain/fade/deadline enforcement. A lock-free native fault latch prevents
later callbacks or enqueue from reviving a faulted queue without a new activation.

Active routes come from `AVAudioSession.currentRoute`. IDs exposed to the portable
layer are opaque and ephemeral; accessory names and persistent hardware UIDs are
not exported. Unknown, Bluetooth, AirPlay and USB outputs remain `unknown`, not
speaker proof. The host checks route stability while activating. Actual output
sample rate and channel count are required; resampling, remixing and calibration
belong to explicit upstream adapters, not implicit host conversions.

Route changes, interruptions, media-services reset/loss, engine configuration
change or foreground loss latch silence and invalidate the graph. Start/rejoin is
explicit. **This first host is foreground-only:** calls, app switching and lock
screen stop playback. It neither requests nor claims continuous background audio.
The application must not share audio-session ownership with another host without
its own explicit session coordinator.

## Bridge wiring

Create one host on the main actor. Subscribe before calling `start()` after a user
action. Translate `routeActive` to the TypeScript `route-active` event with exactly
`route`, `sampleRate`, and `maxChannels`; translate interruptions, disconnects and
completed IDs without adding fields. Use `IOSAudioHost.nowHostTimeMs()` as the
native host-clock reference for the TypeScript sink, with bounded synchronous
clock sampling. Do not mix uptime, Unix time and host-clock epochs.

Pass the dispatched `id` and `routeGeneration` unchanged. Validate the bridge's
`frames * channels == samples.count` before constructing `NativePCMRequest`;
sample rate and channel count must exactly match the announced format. The C
kernel owns a copy before enqueue returns. The caller still owns its source PCM
and must erase/release its own temporary views. Do not serialize this plaintext
through a server, log, analytics pipeline or disk queue.

Map `updateEnvelope`, `cancel` and `cancelAll` to their host methods synchronously;
map close to `host.close()`. Completion drains native buffer ownership, not proof
that a listener heard sound. Queue cancellation affects future render output;
already rendered OS/hardware buffers cannot be recalled by this library. Device
measurements must bound that latency before product safety/timing claims.

## Verification and remaining acceptance

`swift test` exercises the actual Swift/C boundary: owned copies, exact formats,
invalid PCM, generation isolation, stale cancellation, contraction, fault latch,
completion accounting and stereo/late-frame rendering. CI separately compiles the
real iOS-only AVAudioSession/AVAudioEngine code for an unsigned simulator target.
Neither test establishes physical output, acoustic synchronization or iPhone
interruption behavior. Keep DAE-10 partial until the consumer runtime bridge,
real devices/routes, secure native state, signed controls/key-channel integration
and the supported-device matrix pass. The native host performs no cryptographic
key agreement, command authentication, media networking or billing.

Primary API references: Apple AVAudioSourceNode, AVAudioSession.currentRoute,
AVAudioTime.seconds(forHostTime:), AVAudioSession interruption/route notifications.

## JavaScriptCore audio bridge

[JavaScriptCoreAudioBridge](javascriptcore.md) now connects a trusted application
JSContext synchronously to the actual iOS audio host. Its platform runtime tests
are separate from Node integration tests. It does not provision the complete
endpoint's WebCrypto/web globals, module loader or authenticated parent channel.
