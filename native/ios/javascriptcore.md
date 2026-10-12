# JavaScriptCore-to-iOS audio bridge

`JavaScriptCoreAudioBridge` exports the existing `IOSAudioBridge` audio contract
into an application-owned, trusted JavaScriptCore context. It uses system APIs,
with no third-party JavaScript VM, new cryptographic protocol, network endpoint,
app signing, or remote-script loader.

```swift
import JavaScriptCore
import DistributedAudioHost

// Run construction, script evaluation and teardown on the main actor.
let context = JSContext()!
let host = IOSAudioHost()
let bridge = try JavaScriptCoreAudioBridge(context: context, host: host)
context.setObject(bridge.javascriptObject, forKeyedSubscript: "nativeAudio" as NSString)
// Retain context and bridge for this foreground playback lifetime.
// Install the application's approved endpoint runtime and bundled source here.
// On explicit leave / teardown:
bridge.close()
```

The JavaScript object supplies `subscribe`, `enqueue`, `updateEnvelope`, `cancel`
and `cancelAll`, plus `nowHostTimeMs`, explicit `start`, `stop` and `close`.
Subscribe before starting the host. Forward that same object to `IOSAudioSink`
or `EndpointPlaybackSession.ios`, and its native clock function to the sink's
`nowHostTimeMs` option. Native route return never substitutes for a newly signed
lease or explicit session rejoin. `bridge.close()` also closes its native host;
close the owned portable session as part of application teardown.

## Actual scope versus remaining work

This is a real embedded JavaScript-to-Swift/C audio handoff and an actual
`IOSAudioHost` integration, not a serialized transport or a bridge double. It is
**not a complete endpoint runtime**. JavaScriptCore is not a browser: the consuming
application must still provide a qualified module-loading/build path, the
engine's required WebCrypto and web globals, and an approved authenticated
parent/manifest/key channel. No fake crypto, temporary production key, plaintext
manifest fallback, or custom key agreement is installed by this bridge.

The caller controls which trusted, bundled code runs in the context. This is not
a sandbox for untrusted JavaScript or remotely supplied executable code. The
native handoff accepts endpoint-decoded PCM only after the portable session has
authenticated authority and checked rights. It does not authenticate a remote
command by itself. All context operations and native event callbacks belong to
the main actor. The app must close the bridge explicitly when leaving; do not
use JavaScript garbage collection as a playback shutdown signal.

## Copying, bounds and lifecycle

The bridge captures its parsing helpers, rejects accessors and unexpected PCM
request members, requires actual Float32Array storage, and rejects shared or
resizable backing buffers. Native parsing independently validates scalar types,
finite bounds, safe-integer route generations and exact frame/sample shape before
copying at most four million samples. It accounts for a typed-array subview's
byte offset, and copies its temporary backing pointer before making another
JavaScriptCore call. The synchronous host then copies into the bounded C queue
before returning. The intermediate Swift request copy is cleared on return;
Swift/JavaScript copies and garbage collection are not a secure-erasure guarantee.

Gain conversion rounds down when Float representation would otherwise exceed the
requested ceiling. The existing C kernel enforces route generation, timing,
non-overlap, gain/fade/deadline contraction, buffer limits and native hard stops.
No PCM is JSON/base64 encoded, logged, persisted, or sent over a network here.

There is one subscription owner. Unsubscribe is idempotent and ticket-bound;
stale handles cannot detach a new listener. Native route, interruption, disconnect
and completion events pass through to the portable lifecycle owner. A malformed
request, callback exception or driver failure closes the host and returns only a
generic error; private contents are not inserted into diagnostic messages.
Native clock failure cannot be treated as a valid timing observation.

## Verification

`JavaScriptCoreAudioBridgeTests.swift` contains ten macOS JavaScriptCore/Swift/C
cases covering typed-array subviews and owned copies, envelope contraction and
hard stop, actual native callbacks, invalid metadata and samples, rejected getters,
callback failure, unsubscribe/rejoin and explicit close. These tests use the real
JavaScriptCore VM and production C queue with a synthetic host clock and route.
The same native CI separately compiles the concrete iOS AVAudioEngine host and
bridge for an unsigned simulator target. Linux Swift checks exclude JavaScriptCore
and are not evidence that these ten platform tests executed.

Device playback, route latency, main-thread scheduling load, six-hour soaks,
background playback, protected state and independent review remain unpassed gates.
Compilation or these runtime tests do not establish audible physical output.
