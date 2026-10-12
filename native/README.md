# Native endpoint playback

This tree is the native implementation track for DAE-09, DAE-10, DAE-11,
DAE-12 and DAE-27. It is not a server and must run only at an authorized
recipient endpoint. The portable engine still authenticates controls, checks
rights, and decrypts protected media before handing bounded PCM to a host.
No media key, private manifest or PCM is sent to a relay by these components.

## Implementation order and acceptance

1. Shared native PCM kernel and hardened TypeScript dispatch identity: C11
   bounded storage, owned copies, route-generation checks, contraction-only
   gain/fade/deadline updates, allocation-free/non-waiting render, late-frame
   skipping and control-thread plaintext cleanup. CI runs contract cases,
   adversarial sequences, concurrent control/render and ASan/UBSan. This is
   software evidence, not acoustic or platform evidence.
2. Android host: buildable Android library with AudioTrack, actual routed-device
   observations, timestamp-based presentation estimates, audio-focus/noisy/app
   lifecycle invalidation, and a synchronous JNI handoff to the native kernel.
   Acceptance includes Android compilation plus JNI/host-boundary tests;
   physical routes, interruptions and lock-screen behavior need device trials.
3. iOS host: Swift package with AVAudioSession/AVAudioEngine/AVAudioSourceNode,
   host-clock render timestamps, actual current-route observations, interruption,
   reset and app-state handling. Acceptance includes Swift tests and unsigned
   iOS-simulator compilation. Actual iPhones and speaker routes remain separate.
4. Consumer bridge wiring, supported-device matrix and six-hour soaks: exercise
   actual signed-authority-to-native playback, route changes, loss/rejoin, drift,
   Bluetooth/wired output delay, suspension and endpoint-controlled secure state.
   Do not complete native, acoustic, integrated-release or security gates from
   compilation, an emulator or synthetic timestamps.

Canonical milestone tracking remains `registry/roadmap.json`; these packages
refine existing milestones and do not add new product milestones. Each native
host must document supported behavior and unresolved gates in its own README.

## C kernel

Run from the repository root:

```sh
cmake -S native/core -B /tmp/dae-native -DCMAKE_BUILD_TYPE=Debug
cmake --build /tmp/dae-native --parallel 2
ctest --test-dir /tmp/dae-native --output-on-failure
```

`core/include/dae_pcm.h` is a C ABI usable from Swift and JNI. A queue has a fixed
sample rate/channel count, at most 64 voice slots, at most 16,777,216 stored
samples, at most 5 seconds of scheduled authority, and at most 8192 frames per
render. A renderer that cannot acquire the queue lock immediately emits silence;
it never waits, allocates, frees, invokes application callbacks or logs PCM.
Completion cleanup runs off the audio callback. A host must drain completions
regularly, stop/deactivate on render faults, and synchronize destruction with
all callers. Silence on contention can cause dropout and must be measured.

Scheduling timestamps describe the host's **estimated presentation timeline**.
They do not establish acoustic alignment, sound level, source attribution or a
specific Bluetooth delay. Already delivered hardware buffers cannot be recalled
by this library. Native hosts must stop/flush their driver on interruption and
never automatically replay a stale queue after reconnect or foreground return.

## TypeScript/native contract changes

This unreleased development SDK now includes `routeGeneration` in each Android
and iOS PCM request. Reject a request unless it matches the active native route.
The request `id` is an opaque per-dispatch ID, not the caller's logical clip ID.
Echo that ID exactly on completion and use it for envelope/cancellation calls.
This prevents a delayed completion from retiring a newly reused clip label.
Gain and native deadlines for an already queued buffer can only contract; new
authority or a higher user gain applies to newly scheduled output.

No credentials or paid resources are required for native compilation/tests.
App signing, distribution, consumer identity/key channels, secure storage,
physical devices and independent review are still separate requirements.

Native code is built from the repository/source artifact, separately from the JavaScript npm package.
