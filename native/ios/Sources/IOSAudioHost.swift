#if os(iOS)
import AVFAudio
import AudioToolbox
import UIKit
import Darwin

public struct NativeOutputRoute: Equatable {
    public let endpointId: String
    public let routeId: String
    public let outputId: String
    public let kind: String
    public let generation: UInt64
}

public enum IOSHostEvent {
    case routeActive(NativeOutputRoute, sampleRate: UInt32, maxChannels: UInt32)
    case interrupted(String)
    case disconnected
    case completed(String)
}

/// Retained by the source node. Neither Swift dictionaries nor the control lock
/// are touched from render. AVAudioEngine serializes this node's render calls.
private final class SourceRenderer {
    let kernel: NativePCMQueue
    let generation: UInt64
    let scratch: UnsafeMutablePointer<Float>
    let capacity: Int
    init(kernel: NativePCMQueue, generation: UInt64) {
        self.kernel = kernel; self.generation = generation
        capacity = 8192 * Int(kernel.channels)
        scratch = .allocate(capacity: capacity)
        scratch.initialize(repeating: 0, count: capacity)
    }
    deinit { scratch.update(repeating: 0, count: capacity); scratch.deallocate() }

    func render(_ silence: UnsafeMutablePointer<ObjCBool>, _ timestamp: UnsafePointer<AudioTimeStamp>,
                _ frames: AVAudioFrameCount, _ data: UnsafeMutablePointer<AudioBufferList>) -> OSStatus {
        let buffers = UnsafeMutableAudioBufferListPointer(data)
        // Zero the real bounded output first, including every rejected callback.
        for buffer in buffers {
            if let output = buffer.mData?.assumingMemoryBound(to: Float.self) {
                output.update(repeating: 0, count: min(Int(frames), Int(buffer.mDataByteSize) / 4))
            }
        }
        silence.pointee = true
        guard frames > 0, frames <= 8192, buffers.count == Int(kernel.channels),
              timestamp.pointee.mFlags & kAudioTimeStampHostTimeValid != 0 else {
            kernel.latchRenderFault(); return noErr
        }
        for buffer in buffers {
            guard buffer.mNumberChannels == 1, buffer.mData != nil,
                  buffer.mDataByteSize >= frames * 4 else { kernel.latchRenderFault(); return noErr }
        }
        let startMs = AVAudioTime.seconds(forHostTime: timestamp.pointee.mHostTime) * 1000
        let count = Int(frames) * Int(kernel.channels)
        let status = kernel.render(generation: generation, startMs: startMs, frames: frames,
                        output: UnsafeMutableBufferPointer(start: scratch, count: count))
        // Busy is a silence/dropout decision, never a wait or stale replay.
        guard status == 0 else {
            if status != 6 { kernel.latchRenderFault() }
            scratch.update(repeating: 0, count: count)
            return noErr
        }
        for channel in buffers.indices {
            let output = buffers[channel].mData!.assumingMemoryBound(to: Float.self)
            for frame in 0..<Int(frames) { output[frame] = scratch[frame * buffers.count + channel] }
        }
        scratch.update(repeating: 0, count: count)
        silence.pointee = false
        return noErr
    }
}

/// Foreground-only iOS playback host. Start is explicit after a user action and
/// subscription. Route changes, suspension and interruption require fresh start
/// and timeline join; nothing is automatically replayed on recovery.
@MainActor public final class IOSAudioHost {
    private let endpointId = UUID().uuidString
    private var generation: UInt64 = 0
    private var listener: ((IOSHostEvent) -> Void)?
    private var kernel: NativePCMQueue?
    private var engine: AVAudioEngine?
    private var source: AVAudioSourceNode?
    private var observers: [NSObjectProtocol] = []
    private var completionTimer: DispatchSourceTimer?
    private var ownsSession = false
    private var closed = false

    public init() {}
    public nonisolated static func nowHostTimeMs() -> Double {
        AVAudioTime.seconds(forHostTime: mach_absolute_time()) * 1000
    }
    public func subscribe(_ handler: @escaping (IOSHostEvent) -> Void) throws -> () -> Void {
        guard !closed, listener == nil else { throw NativeAudioError.unavailable }
        listener = handler
        return { [weak self] in self?.stop(); self?.listener = nil }
    }

    public func start() throws {
        guard !closed, listener != nil, UIApplication.shared.applicationState == .active,
              generation < 9_007_199_254_740_989 else { throw NativeAudioError.unavailable }
        if kernel != nil { stop() }
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default)
            try session.setActive(true); ownsSession = true
            let engine = AVAudioEngine()
            let hardware = engine.outputNode.inputFormat(forBus: 0)
            let outputs = session.currentRoute.outputs
            let rate = hardware.sampleRate, channels = hardware.channelCount
            guard rate.isFinite, rate >= 8000, rate <= 192000, rate.rounded() == rate,
                  channels >= 1, channels <= 8, outputs.count == 1,
                  let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: channels) else {
                throw NativeAudioError.unavailable
            }
            generation += 1
            let kernel = try NativePCMQueue(sampleRate: UInt32(rate), channels: channels)
            try kernel.activate(generation: generation, nowMs: Self.nowHostTimeMs())
            let renderer = SourceRenderer(kernel: kernel, generation: generation)
            let node = AVAudioSourceNode(format: format) { renderer.render($0, $1, $2, $3) }
            engine.attach(node)
            engine.connect(node, to: engine.mainMixerNode, format: format)
            engine.mainMixerNode.outputVolume = 1
            self.kernel = kernel; self.engine = engine; self.source = node
            engine.prepare(); try engine.start()
            guard session.currentRoute.outputs.map(\.uid) == outputs.map(\.uid) else {
                throw NativeAudioError.unavailable
            }
            observe(session: session, engine: engine, kernel: kernel)
            let output = outputs[0]
            let kind: String
            switch output.portType {
            case .builtInSpeaker, .builtInReceiver: kind = "internal"
            case .headphones, .headsetMic: kind = "headphones"
            default: kind = "unknown" // Bluetooth names/types cannot prove a speaker.
            }
            let route = NativeOutputRoute(endpointId: endpointId, routeId: UUID().uuidString,
                outputId: UUID().uuidString, kind: kind, generation: generation)
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now() + .milliseconds(20), repeating: .milliseconds(20))
            timer.setEventHandler { [weak self] in self?.poll() }
            completionTimer = timer; timer.resume()
            listener?(.routeActive(route, sampleRate: UInt32(rate), maxChannels: channels))
        } catch {
            shutdown(); generation += 1; listener?(.interrupted("engine-stopped")); throw error
        }
    }

    private func observe(session: AVAudioSession, engine: AVAudioEngine, kernel: NativePCMQueue) {
        let events: [(Notification.Name, AnyObject?, String)] = [
            (AVAudioSession.interruptionNotification, session, "audio-session-interruption"),
            (AVAudioSession.routeChangeNotification, session, "old-device-unavailable"),
            (AVAudioSession.mediaServicesWereResetNotification, session, "media-services-reset"),
            (AVAudioSession.mediaServicesWereLostNotification, session, "media-services-reset"),
            (.AVAudioEngineConfigurationChange, engine, "engine-stopped"),
            (UIApplication.willResignActiveNotification, nil, "app-suspended")
        ]
        for (name, object, reason) in events {
            let token = NotificationCenter.default.addObserver(forName: name, object: object, queue: nil) { [weak self, kernel] _ in
                // Notification delivery may not be on the main thread.
                kernel.latchRenderFault()
                DispatchQueue.main.async { [weak self] in self?.interrupt(reason, expected: kernel) }
            }
            observers.append(token)
        }
    }
    private func interrupt(_ reason: String, expected: NativePCMQueue) {
        guard kernel === expected else { return } // An old notification cannot stop a new route.
        shutdown(); generation += 1; listener?(.interrupted(reason))
    }
    private func poll() {
        guard let kernel else { return }
        guard engine?.isRunning == true, kernel.state.active, !kernel.state.timingFault else {
            interrupt("engine-stopped", expected: kernel); return
        }
        for id in kernel.drainCompleted() { listener?(.completed(id)) }
    }
    public func enqueue(_ request: NativePCMRequest) throws {
        guard !closed, let kernel, engine?.isRunning == true else { throw NativeAudioError.unavailable }
        try kernel.enqueue(request, nowMs: Self.nowHostTimeMs())
    }
    public func updateEnvelope(id: String, gainCeiling: Float, fadeStartMs: Double, stopAtMs: Double) throws {
        guard !closed, let kernel else { throw NativeAudioError.unavailable }
        try kernel.updateEnvelope(id: id, gainCeiling: gainCeiling, fadeStartMs: fadeStartMs, stopAtMs: stopAtMs)
    }
    public func cancel(id: String) { kernel?.cancel(id: id) }
    public func cancelAll() { kernel?.cancelAll() }

    private func shutdown() {
        completionTimer?.cancel(); completionTimer = nil
        observers.forEach(NotificationCenter.default.removeObserver); observers.removeAll()
        kernel?.deactivate()
        engine?.stop(); engine?.reset(); engine = nil; source = nil; kernel = nil
        if ownsSession {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
            ownsSession = false
        }
    }
    public func stop() { shutdown(); generation += 1; listener?(.disconnected) }
    public func close() { guard !closed else { return }; stop(); listener = nil; closed = true }
    deinit {
        // Destruction cannot invoke actor-bound user callbacks.
        completionTimer?.cancel()
        observers.forEach(NotificationCenter.default.removeObserver)
        kernel?.deactivate(); engine?.stop()
    }
}
#endif
