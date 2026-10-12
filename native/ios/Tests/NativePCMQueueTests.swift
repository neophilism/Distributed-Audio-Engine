import XCTest
@testable import DistributedAudioHost

final class NativePCMQueueTests: XCTestCase {
    func queue(channels: UInt32 = 1) throws -> NativePCMQueue {
        let q = try NativePCMQueue(sampleRate: 8000, channels: channels, maxSamples: 128)
        try q.activate(generation: 1, nowMs: 1000); return q
    }
    func request(id: String = "dispatch-1", generation: UInt64 = 1, samples: [Float] = [Float](repeating: 1, count: 8),
                 channels: UInt32 = 1, gain: Float = 1, start: Double = 1000, stop: Double = 1001) -> NativePCMRequest {
        NativePCMRequest(id: id, routeGeneration: generation, samples: samples, sampleRate: 8000,
            channels: channels, startAtHostTimeMs: start, fadeStartHostTimeMs: stop, stopAtHostTimeMs: stop, gainCeiling: gain)
    }
    func render(_ q: NativePCMQueue, start: Double = 1000, generation: UInt64 = 1, frames: UInt32 = 16) -> [Float] {
        var output = [Float](repeating: 10, count: Int(frames * q.channels))
        output.withUnsafeMutableBufferPointer { _ = q.render(generation: generation, startMs: start, frames: frames, output: $0) }
        return output
    }
    func testCopiedPCMAndHardStop() throws {
        let q = try queue(); var samples = [Float](repeating: 0.5, count: 8)
        try q.enqueue(request(samples: samples), nowMs: 1000); samples[0] = 0
        let output = render(q)
        XCTAssertEqual(Array(output.prefix(8)), [Float](repeating: 0.5, count: 8))
        XCTAssertEqual(Array(output.suffix(8)), [Float](repeating: 0, count: 8))
        XCTAssertEqual(q.drainCompleted(), ["dispatch-1"]); XCTAssertEqual(q.state.queuedSamples, 0)
    }
    func testRejectInvalidFormatsAndSamples() throws {
        let q = try queue()
        XCTAssertThrowsError(try q.enqueue(request(channels: 2), nowMs: 1000))
        XCTAssertThrowsError(try q.enqueue(request(samples: [.nan]), nowMs: 1000))
        XCTAssertThrowsError(try q.enqueue(request(id: "bad/id"), nowMs: 1000))
        XCTAssertEqual(q.state.occupiedVoices, 0)
    }
    func testGenerationInvalidation() throws {
        let q = try queue(); try q.enqueue(request(), nowMs: 1000); q.deactivate()
        XCTAssertEqual(q.state.queuedSamples, 0)
        XCTAssertThrowsError(try q.activate(generation: 1, nowMs: 1000))
        try q.activate(generation: 3, nowMs: 1000)
        XCTAssertThrowsError(try q.enqueue(request(), nowMs: 1000))
        try q.enqueue(request(generation: 3), nowMs: 1000)
        XCTAssertTrue(render(q).allSatisfy { $0 == 0 })
        XCTAssertEqual(render(q, generation: 3).first, 1)
    }
    func testEnvelopeContractionAndCancellation() throws {
        let q = try queue(); try q.enqueue(request(), nowMs: 1000)
        try q.updateEnvelope(id: "dispatch-1", gainCeiling: 0.25, fadeStartMs: 1000.5, stopAtMs: 1000.75)
        try q.updateEnvelope(id: "dispatch-1", gainCeiling: 1, fadeStartMs: 2000, stopAtMs: 2000)
        let output = render(q); XCTAssertEqual(output[0], 0.25); XCTAssertEqual(output[6], 0)
        q.cancelAll(); XCTAssertEqual(q.state.queuedSamples, 0)
    }
    func testRenderFaultIsLatchedUntilFreshActivation() throws {
        let q = try queue(); try q.enqueue(request(), nowMs: 1000)
        q.latchRenderFault(); XCTAssertTrue(q.state.timingFault); XCTAssertFalse(q.state.active)
        XCTAssertTrue(render(q).allSatisfy { $0 == 0 })
        XCTAssertThrowsError(try q.enqueue(request(id: "new", start: 1001, stop: 1002), nowMs: 1000))
        try q.activate(generation: 2, nowMs: 1002)
        XCTAssertFalse(q.state.timingFault); XCTAssertTrue(q.state.active)
    }
    func testDuplicateIdsAndCompletionDrain() throws {
        let q = try queue(); try q.enqueue(request(), nowMs: 1000)
        XCTAssertThrowsError(try q.enqueue(request(), nowMs: 1000))
        _ = render(q); XCTAssertEqual(q.drainCompleted().count, 1); XCTAssertTrue(q.drainCompleted().isEmpty)
        // Delayed cancellation names are opaque IDs, never recycled logical labels.
        try q.enqueue(request(id: "dispatch-2", start: 1002, stop: 1003), nowMs: 1002)
        q.cancel(id: "dispatch-1"); XCTAssertEqual(q.state.occupiedVoices, 1)
    }
    func testStereoInterleavingAndNoLateReplay() throws {
        let q = try queue(channels: 2)
        let samples: [Float] = [1,-1,0.5,-0.5,0.25,-0.25,0.125,-0.125]
        try q.enqueue(request(samples: samples, channels: 2, stop: 1000.5), nowMs: 1000)
        XCTAssertEqual(Array(render(q, start: 1000.25, frames: 2)), [0.25,-0.25,0.125,-0.125])
    }
}
