public struct NativeOutputRoute: Equatable {
    public let endpointId: String
    public let routeId: String
    public let outputId: String
    public let kind: String
    public let generation: UInt64
    public init(endpointId: String, routeId: String, outputId: String, kind: String, generation: UInt64) {
        self.endpointId = endpointId; self.routeId = routeId; self.outputId = outputId
        self.kind = kind; self.generation = generation
    }
}

public enum IOSHostEvent {
    case routeActive(NativeOutputRoute, sampleRate: UInt32, maxChannels: UInt32)
    case interrupted(String)
    case disconnected
    case completed(String)
}

/// A synchronous, same-endpoint driver. Implementations copy PCM before return
/// and deliver callbacks on the main actor. This is not remote authorization.
@MainActor public protocol EmbeddedAudioHost: AnyObject {
    func currentHostTimeMs() -> Double
    func subscribe(_ handler: @escaping (IOSHostEvent) -> Void) throws -> () -> Void
    func start() throws
    func enqueue(_ request: NativePCMRequest) throws
    func updateEnvelope(id: String, gainCeiling: Float, fadeStartMs: Double, stopAtMs: Double) throws
    func cancel(id: String)
    func cancelAll()
    func stop()
    func close()
}
