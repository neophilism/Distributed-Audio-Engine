import Foundation
import DAEPCMCore

public enum NativeAudioError: Error, Equatable {
    case invalidRequest
    case nativeStatus(UInt32)
    case unavailable
}

/// A synchronous endpoint-only handoff. Call only after portable authority and
/// rights validation. This type does not authenticate commands or obtain keys.
public struct NativePCMRequest {
    public let id: String
    public let routeGeneration: UInt64
    public let samples: [Float]
    public let sampleRate: UInt32
    public let channels: UInt32
    public let startAtHostTimeMs: Double
    public let fadeStartHostTimeMs: Double
    public let stopAtHostTimeMs: Double
    public let gainCeiling: Float

    public init(id: String, routeGeneration: UInt64, samples: [Float], sampleRate: UInt32,
                channels: UInt32, startAtHostTimeMs: Double, fadeStartHostTimeMs: Double,
                stopAtHostTimeMs: Double, gainCeiling: Float) {
        self.id = id; self.routeGeneration = routeGeneration; self.samples = samples
        self.sampleRate = sampleRate; self.channels = channels
        self.startAtHostTimeMs = startAtHostTimeMs; self.fadeStartHostTimeMs = fadeStartHostTimeMs
        self.stopAtHostTimeMs = stopAtHostTimeMs; self.gainCeiling = gainCeiling
    }
}

public struct NativeQueueState {
    public let generation: UInt64
    public let queuedSamples: Int
    public let occupiedVoices: UInt32
    public let active: Bool
    public let timingFault: Bool
}

/// Dictionary mutations are control-thread locked; rendering touches only the C
/// queue with try-lock semantics. Keep a strong reference throughout callbacks.
// All mutable Swift state is under control; C state is mutex/atomic protected.
public final class NativePCMQueue: @unchecked Sendable {
    private let queue: OpaquePointer
    private let control = NSLock()
    public let sampleRate: UInt32
    public let channels: UInt32
    private var nextToken: UInt64 = 0
    private var generation: UInt64 = 0
    private var tokens: [String: UInt64] = [:]
    private var ids: [UInt64: String] = [:]

    public init(sampleRate: UInt32, channels: UInt32, maxSamples: UInt32 = 4 * 1024 * 1024,
                horizonMs: Double = 1000) throws {
        guard let q = dae_pcm_create(dae_pcm_config(sample_rate: sampleRate, channels: channels,
                        max_voices: 64, max_samples: maxSamples, horizon_ms: horizonMs)) else {
            throw NativeAudioError.invalidRequest
        }
        queue = q; self.sampleRate = sampleRate; self.channels = channels
    }
    deinit { dae_pcm_destroy(queue) }

    private func check(_ status: dae_pcm_status) throws {
        if status != DAE_PCM_OK { throw NativeAudioError.nativeStatus(status.rawValue) }
    }
    public func activate(generation: UInt64, nowMs: Double) throws {
        control.lock(); defer { control.unlock() }
        try check(dae_pcm_activate(queue, generation, nowMs))
        self.generation = generation; tokens.removeAll(); ids.removeAll()
    }
    public func deactivate() {
        control.lock(); defer { control.unlock() }
        dae_pcm_deactivate(queue); tokens.removeAll(); ids.removeAll()
    }
    /// Lock-free latch, safe from a platform render callback.
    public func latchRenderFault() { dae_pcm_latch_fault(queue) }

    public func enqueue(_ request: NativePCMRequest, nowMs: Double) throws {
        control.lock(); defer { control.unlock() }
        let bytes = Array(request.id.utf8)
        func alphaNumeric(_ b: UInt8) -> Bool { (48...57).contains(b) || (65...90).contains(b) || (97...122).contains(b) }
        guard !bytes.isEmpty, bytes.count <= 128, alphaNumeric(bytes[0]),
              bytes.allSatisfy({ alphaNumeric($0) || [45,46,58,95].contains($0) }),
              request.sampleRate == sampleRate, request.channels == channels,
              request.routeGeneration == generation, tokens[request.id] == nil,
              nextToken < UInt64.max else { throw NativeAudioError.invalidRequest }
        nextToken += 1
        let token = nextToken
        let status = request.samples.withUnsafeBufferPointer { samples in
            var native = dae_pcm_request(token: token, generation: request.routeGeneration,
                samples: samples.baseAddress, sample_count: samples.count, now_ms: nowMs,
                starts_at_ms: request.startAtHostTimeMs, fade_start_ms: request.fadeStartHostTimeMs,
                stops_at_ms: request.stopAtHostTimeMs, gain_ceiling: request.gainCeiling)
            return dae_pcm_enqueue(queue, &native)
        }
        try check(status)
        tokens[request.id] = token; ids[token] = request.id
    }
    public func updateEnvelope(id: String, gainCeiling: Float, fadeStartMs: Double, stopAtMs: Double) throws {
        control.lock(); defer { control.unlock() }
        // Completion may have drained immediately before a portable update.
        guard let token = tokens[id] else { return }
        try check(dae_pcm_update(queue, generation, token, gainCeiling, fadeStartMs, stopAtMs))
    }
    public func cancel(id: String) {
        control.lock(); defer { control.unlock() }
        guard let token = tokens.removeValue(forKey: id) else { return }
        ids.removeValue(forKey: token); _ = dae_pcm_cancel(queue, generation, token)
    }
    public func cancelAll() {
        control.lock(); defer { control.unlock() }
        dae_pcm_cancel_all(queue); tokens.removeAll(); ids.removeAll()
    }
    /// Off the audio thread: drains buffer ownership, not acoustic completion.
    public func drainCompleted() -> [String] {
        control.lock(); defer { control.unlock() }
        var result: [String] = [], native = [UInt64](repeating: 0, count: 64)
        let count = native.withUnsafeMutableBufferPointer { dae_pcm_drain(queue, $0.baseAddress, $0.count) }
        for token in native.prefix(count) {
            if let id = ids.removeValue(forKey: token) { tokens.removeValue(forKey: id); result.append(id) }
        }
        return result
    }
    public var state: NativeQueueState {
        let s = dae_pcm_inspect(queue)
        return NativeQueueState(generation: s.generation, queuedSamples: s.queued_samples,
            occupiedVoices: s.occupied_voices, active: s.active != 0, timingFault: s.timing_fault != 0)
    }
    /// No allocation or waiting. The caller owns and validates the buffer capacity.
    @discardableResult public func render(generation: UInt64, startMs: Double, frames: UInt32,
                        output: UnsafeMutableBufferPointer<Float>) -> UInt32 {
        dae_pcm_render(queue, generation, startMs, frames, output.baseAddress, output.count).rawValue
    }
}
