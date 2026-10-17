# iOS endpoint audio host binding (DAE-10 partial)

Import `IOSAudioSink` from `@neophilism/distributed-audio-engine/ios`. This module binds the portable current-position player and signed playback authority to a trusted iOS host. It does not claim that any iPhone, iPad, route or acoustic path is qualified.

The host implementation must derive active routes from `AVAudioSession.currentRoute` and route-change notifications, maintain a strictly increasing route generation, and render PCM through a bounded `AVAudioEngine` / `AVAudioSourceNode` graph configured for the reported sample rate and channel capacity. Stored accessory names and previously connected routes are not active-output evidence. The bridge must copy each request into Swift/native-owned storage before `enqueue` returns because the SDK immediately wipes its temporary PCM view.

Scheduling maps Unix timeline targets onto a nondecreasing host-time source, rejects rollback, requires an exact sample rate, bounds channel layouts and queued samples, and rejects overlapping output. Signed authority supplies the gain ceiling, fade start and hard stop that the native graph must enforce without depending on JavaScript timers. Renewals may reduce an existing deadline but never extend queued output.

Audio-session interruptions, old-device-unavailable route changes, media-services resets, unsafe suspension, engine stops and disconnects invalidate queued output. Resumption requires a newly active route generation and a fresh timeline join. The supplied native host is foreground-only: app switching or lock screen stops output. A future background implementation may continue only after its audio-session category, entitlement, signed authority, engine state and route behavior are implemented and qualified; the portable layer does not infer that state.

The foreground Swift host now has real Swift/C tests and unsigned iOS-simulator compilation. Portable host-double tests cover buffer copying, host-time translation, route generations, interruption/reset invalidation, authority contraction, queue bounds and fail-closed bridge errors. DAE-10 remains incomplete until the [native Swift host](../native/ios/README.md), consuming runtime bridge and supported-device matrix exercise interruptions, lock screen, permissions/session activation, route changes, reconnects, media-services resets, engine restarts and OS-version behavior. No deployment, hardware, field or release evidence is asserted.

Native implementation work and the route-generation/opaque-dispatch-ID contract are described in [native endpoint playback](../native/README.md). Echo the dispatched ID, not the logical clip label.

Malformed native bridge callbacks now revoke endpoint authority, interrupt the output lifecycle and attempt native queue cancellation even if the driver itself is faulted. These software checks do not establish physical speaker-stop latency; native deadlines and field qualification remain separate.
