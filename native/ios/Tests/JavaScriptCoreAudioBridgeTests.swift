#if canImport(JavaScriptCore)
import XCTest
import JavaScriptCore
@testable import DistributedAudioHost

// Real JSCore and C rendering; synthetic clocks/routes, no AVAudioEngine/device.
@MainActor private final class ScriptHost: EmbeddedAudioHost {
    let kernel = try! NativePCMQueue(sampleRate: 8000, channels: 2, maxSamples: 128)
    var now: Double = 1000
    var generation: UInt64 = 0
    var listener: ((IOSHostEvent) -> Void)?
    var closed = false
    func currentHostTimeMs() -> Double { now }
    func subscribe(_ handler: @escaping (IOSHostEvent) -> Void) throws -> () -> Void {
        guard !closed, listener == nil else { throw NativeAudioError.unavailable }
        listener = handler
        return { [weak self] in self?.stop(); self?.listener = nil }
    }
    func start() throws {
        guard !closed, listener != nil else { throw NativeAudioError.unavailable }
        generation += 1; try kernel.activate(generation: generation, nowMs: now)
        listener?(.routeActive(NativeOutputRoute(endpointId: "test-endpoint", routeId: "test-route",
                    outputId: "test-output", kind: "unknown", generation: generation), sampleRate: 8000, maxChannels: 2))
    }
    func enqueue(_ request: NativePCMRequest) throws { try kernel.enqueue(request, nowMs: now) }
    func updateEnvelope(id: String, gainCeiling: Float, fadeStartMs: Double, stopAtMs: Double) throws {
        try kernel.updateEnvelope(id: id, gainCeiling: gainCeiling, fadeStartMs: fadeStartMs, stopAtMs: stopAtMs)
    }
    func cancel(id: String) { kernel.cancel(id: id) }
    func cancelAll() { kernel.cancelAll() }
    func stop() { kernel.deactivate(); generation += 1; listener?(.disconnected) }
    func close() { if !closed { closed = true; stop(); listener = nil } }
    func render(_ time: Double = 1000, frames: UInt32 = 8) -> [Float] {
        var samples = [Float](repeating: -10, count: Int(frames * 2))
        samples.withUnsafeMutableBufferPointer { _ = kernel.render(generation: generation, startMs: time, frames: frames, output: $0) }
        for id in kernel.drainCompleted() { listener?(.completed(id)) }
        return samples
    }
}
@MainActor private func setupBridge(start: Bool = true) throws -> (JSContext, JavaScriptCoreAudioBridge, ScriptHost) {
    let context = JSContext()!, host = ScriptHost()
    let bridge = try JavaScriptCoreAudioBridge(context: context, host: host)
    context.setObject(bridge.javascriptObject, forKeyedSubscript: "audio" as NSString)
    _ = context.evaluateScript("var events = []; var unsubscribe = audio.subscribe(event => events.push(event));")
    if start { _ = context.evaluateScript("audio.start();") }
    XCTAssertNil(context.exception)
    return (context, bridge, host)
}
private let requestScript = """
var request = {id:'dispatch-1', routeGeneration:1, sampleRate:8000, channels:2, frames:8,
  startAtHostTimeMs:1000, fadeStartHostTimeMs:1001, stopAtHostTimeMs:1001, gainCeiling:0.5,
  samples:new Float32Array(16).fill(0.5)};
"""
final class JavaScriptCoreAudioBridgeTests: XCTestCase {
    func testSynchronousOwnedCopyAndSubarrayOffset() async throws {
        try await MainActor.run {
            let (context, bridge, host) = try setupBridge(); defer { bridge.close() }
            _ = context.evaluateScript(requestScript + """
              var whole = new Float32Array(32).fill(NaN);
              request.samples = whole.subarray(8,24); request.samples.fill(0.5);
              audio.enqueue(request); whole.fill(0);
            """)
            XCTAssertNil(context.exception)
            XCTAssertEqual(host.kernel.state.queuedSamples, 16)
            XCTAssertEqual(host.render(), [Float](repeating: 0.25, count: 16))
        }
    }
    func testGainContractionHardStopAndCancellation() async throws {
        try await MainActor.run {
            let (context, bridge, host) = try setupBridge(); defer { bridge.close() }
            _ = context.evaluateScript(requestScript + """
              audio.enqueue(request);
              audio.updateEnvelope('dispatch-1',0.25,1000.5,1000.75);
              audio.updateEnvelope('dispatch-1',1,2000,3000);
            """)
            XCTAssertNil(context.exception)
            let output = host.render()
            XCTAssertEqual(output[0], 0.125); XCTAssertEqual(output[12], 0)
            _ = context.evaluateScript("audio.cancelAll();")
            XCTAssertNil(context.exception); XCTAssertEqual(host.kernel.state.queuedSamples, 0)
        }
    }
    func testNativeEventsAndClockPassThroughUnchanged() async throws {
        try await MainActor.run {
            let (context, bridge, host) = try setupBridge(); defer { bridge.close() }
            XCTAssertEqual(context.evaluateScript("events[0].route.outputId")?.toString(), "test-output")
            XCTAssertEqual(context.evaluateScript("events[0].route.kind")?.toString(), "unknown")
            XCTAssertEqual(context.evaluateScript("audio.nowHostTimeMs()")?.toDouble(), 1000)
            _ = context.evaluateScript(requestScript + "audio.enqueue(request);")
            _ = host.render(1001)
            XCTAssertNil(context.exception)
            XCTAssertEqual(context.evaluateScript("events[events.length-1].id")?.toString(), "dispatch-1")
        }
    }
    func testMalformedSamplesAndMetadataFailClosed() async throws {
        try await MainActor.run {
            for mutation in ["request.samples = new Uint8Array(16)", "request.samples = []",
                             "request.samples[0] = NaN", "request.frames = 999999999999",
                             "request.sampleRate = 48000", "request.routeGeneration = 2",
                             "request.gainCeiling = 1.01", "request.channels = '2'",
                             "request.extra = 1"] {
                let (context, bridge, host) = try setupBridge(); defer { bridge.close() }
                _ = context.evaluateScript(requestScript + mutation + "; audio.enqueue(request);")
                XCTAssertNotNil(context.exception, mutation); XCTAssertTrue(host.closed)
                XCTAssertEqual(host.kernel.state.queuedSamples, 0)
            }
        }
    }
    func testRequestAccessorsAreRejectedWithoutExecutingThem() async throws {
        try await MainActor.run {
            let (context, bridge, host) = try setupBridge(); defer { bridge.close() }
            _ = context.evaluateScript(requestScript + """
              var getterRan = false;
              Object.defineProperty(request,'frames',{get(){getterRan=true; return 8;}});
              audio.enqueue(request);
            """)
            XCTAssertNotNil(context.exception); context.exception = nil
            XCTAssertFalse(context.evaluateScript("getterRan")!.toBool()); XCTAssertTrue(host.closed)
        }
    }
    func testCallbackExceptionClosesHost() async throws {
        try await MainActor.run {
            let (context, bridge, host) = try setupBridge(start: false); defer { bridge.close() }
            _ = context.evaluateScript("unsubscribe(); audio.subscribe(() => {throw Error('test-failure');}); audio.start();")
            XCTAssertNotNil(context.exception); XCTAssertTrue(host.closed)
            XCTAssertFalse(host.kernel.state.active)
        }
    }
    func testUnsubscribeIsIdempotentAndOldHandleCannotRemoveNewListener() async throws {
        try await MainActor.run {
            let (context, bridge, host) = try setupBridge(); defer { bridge.close() }
            _ = context.evaluateScript("""
              unsubscribe(); var events2=[];
              var unsubscribe2=audio.subscribe(event=>events2.push(event));
              unsubscribe(); audio.start();
            """)
            XCTAssertNil(context.exception); XCTAssertNotNil(host.listener)
            XCTAssertEqual(context.evaluateScript("events2[0].type")?.toString(), "route-active")
        }
    }
    func testReconnectRequiresFreshGeneration() async throws {
        try await MainActor.run {
            let (context, bridge, host) = try setupBridge(); defer { bridge.close() }
            _ = context.evaluateScript(requestScript + "audio.enqueue(request); audio.stop();")
            XCTAssertNil(context.exception); XCTAssertEqual(host.kernel.state.queuedSamples, 0)
            _ = context.evaluateScript("audio.start(); request.routeGeneration=3; request.id='dispatch-2'; audio.enqueue(request);")
            XCTAssertNil(context.exception); XCTAssertEqual(host.render().first, 0.25)
        }
    }
    func testCloseRevokesExistingJavaScriptObject() async throws {
        try await MainActor.run {
            let (context, bridge, host) = try setupBridge()
            _ = context.evaluateScript(requestScript + "audio.enqueue(request);")
            bridge.close(); bridge.close(); XCTAssertNil(bridge.javascriptObject)
            XCTAssertTrue(host.closed); XCTAssertNil(host.listener); XCTAssertEqual(host.kernel.state.queuedSamples, 0)
            _ = context.evaluateScript("audio.enqueue(request);"); XCTAssertNotNil(context.exception)
        }
    }
    func testOnlyOneSubscriptionCanOwnTheHost() async throws {
        try await MainActor.run {
            let (context, bridge, host) = try setupBridge(); defer { bridge.close() }
            _ = context.evaluateScript("audio.subscribe(() => {});")
            XCTAssertNotNil(context.exception); XCTAssertTrue(host.closed)
        }
    }
}
#endif
