#if canImport(JavaScriptCore)
import Foundation
import JavaScriptCore

@MainActor @objc private protocol AudioBridgeExports: JSExport {
    func invoke(_ request: JSValue) -> JSValue?
}
@MainActor private final class AudioBridgeProxy: NSObject, AudioBridgeExports {
    weak var owner: JavaScriptCoreAudioBridge?
    func invoke(_ request: JSValue) -> JSValue? {
        guard Thread.isMainThread else {
            let caller = JSContext.current()
            caller?.exception = JSValue(newErrorFromMessage: "NATIVE_AUDIO_WRONG_THREAD", in: caller)
            return nil
        }
        guard let owner else {
            let context = JSContext.current()
            context?.exception = JSValue(newErrorFromMessage: "NATIVE_AUDIO_BRIDGE_CLOSED", in: context)
            return nil
        }
        return owner.invoke(request)
    }
}

/// Main-actor JavaScriptCore-to-native audio bridge. Install only in an endpoint's
/// trusted, application-owned JSContext; never expose it to downloaded scripts.
/// It does not supply WebCrypto, a module loader, transport or a parent protocol.
@MainActor public final class JavaScriptCoreAudioBridge {
    public private(set) var javascriptObject: JSValue?
    private weak var context: JSContext?
    private let host: EmbeddedAudioHost
    private let proxy = AudioBridgeProxy()
    private var callback: JSValue?
    private var unsubscribe: (() -> Void)?
    private var ticket: UInt64 = 0
    private var closed = false

    public init(context: JSContext, host: EmbeddedAudioHost) throws {
        guard Thread.isMainThread, context.exception == nil else { throw NativeAudioError.unavailable }
        self.context = context; self.host = host
        proxy.owner = self
        guard let factory = context.evaluateScript(Self.factory),
              let object = factory.call(withArguments: [proxy]), object.isObject,
              context.exception == nil else { host.close(); throw NativeAudioError.unavailable }
        javascriptObject = object
    }

    private func number(_ value: JSValue?, min: Double = 0, max: Double = 9_007_199_254_740_991,
                        integral: Bool = false) throws -> Double {
        guard let value, value.isNumber else { throw NativeAudioError.invalidRequest }
        let n = value.toDouble()
        guard n.isFinite, n >= min, n <= max, !integral || n.rounded() == n else { throw NativeAudioError.invalidRequest }
        return n
    }
    private func roundedGain(_ gain: Double) -> Float {
        let converted = Float(gain)
        return Double(converted) > gain ? converted.nextDown : converted
    }
    private func identifier(_ value: JSValue?) throws -> String {
        guard let value, value.isString, let id = value.toString(),
              id.range(of: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}\\z", options: .regularExpression) != nil else {
            throw NativeAudioError.invalidRequest
        }
        return id
    }
    private func copySamples(_ value: JSValue, expectedCount: Int) throws -> [Float] {
        guard let context, value.context.jsGlobalContextRef == context.jsGlobalContextRef, expectedCount > 0, expectedCount <= 4 * 1024 * 1024 else {
            throw NativeAudioError.invalidRequest
        }
        let ctx = context.jsGlobalContextRef
        var exception: JSValueRef?
        guard JSValueGetTypedArrayType(ctx, value.jsValueRef, &exception) == kJSTypedArrayTypeFloat32Array,
              let object = JSValueToObject(ctx, value.jsValueRef, &exception) else { throw NativeAudioError.invalidRequest }
        let count = JSObjectGetTypedArrayLength(ctx, object, &exception)
        let offset = JSObjectGetTypedArrayByteOffset(ctx, object, &exception)
        let size = JSObjectGetTypedArrayByteLength(ctx, object, &exception)
        guard let buffer = JSObjectGetTypedArrayBuffer(ctx, object, &exception), exception == nil else {
            throw NativeAudioError.invalidRequest
        }
        let total = JSObjectGetArrayBufferByteLength(ctx, buffer, &exception)
        guard exception == nil, count == expectedCount, size == count * MemoryLayout<Float>.size,
              offset >= 0, offset <= total, size <= total - offset,
              let base = JSObjectGetTypedArrayBytesPtr(ctx, object, &exception), exception == nil else {
            throw NativeAudioError.invalidRequest
        }
        // The API returns the backing-store base, not the subarray start. This
        // temporary pointer must be copied before ANY further JavaScriptCore call.
        let start = base.advanced(by: offset).assumingMemoryBound(to: Float.self)
        return Array(UnsafeBufferPointer(start: start, count: count))
    }
    private func enqueue(_ value: JSValue) throws {
        let id = try identifier(value.forProperty("id"))
        let generation = try number(value.forProperty("routeGeneration"), min: 1, integral: true)
        let rate = try number(value.forProperty("sampleRate"), min: 8000, max: 192000, integral: true)
        let channels = try number(value.forProperty("channels"), min: 1, max: 8, integral: true)
        let frames = try number(value.forProperty("frames"), min: 1, max: 4 * 1024 * 1024 / channels, integral: true)
        let start = try number(value.forProperty("startAtHostTimeMs"))
        let fade = try number(value.forProperty("fadeStartHostTimeMs"))
        let stop = try number(value.forProperty("stopAtHostTimeMs"))
        let gain = try number(value.forProperty("gainCeiling"), max: 1)
        guard let samples = value.forProperty("samples"), context?.exception == nil else { throw NativeAudioError.invalidRequest }
        var request = NativePCMRequest(id: id, routeGeneration: UInt64(generation),
            samples: try copySamples(samples, expectedCount: Int(frames * channels)),
            sampleRate: UInt32(rate), channels: UInt32(channels), startAtHostTimeMs: start,
            fadeStartHostTimeMs: fade, stopAtHostTimeMs: stop, gainCeiling: roundedGain(gain))
        defer { request.clearSamples() }
        try host.enqueue(request)
    }
    fileprivate func invoke(_ request: JSValue) -> JSValue? {
        guard Thread.isMainThread else { return nil }
        guard let context, let current = JSContext.current(),
              current.jsGlobalContextRef == context.jsGlobalContextRef else {
            close()
            let caller = JSContext.current()
            caller?.exception = JSValue(newErrorFromMessage: "NATIVE_AUDIO_CONTEXT_MISMATCH", in: caller)
            return nil
        }
        do {
            guard let operation = request.forProperty("op")?.toString(), let args = request.forProperty("args"), args.isArray else {
                throw NativeAudioError.invalidRequest
            }
            if operation == "close" { close(); return nil }
            guard !closed else { throw NativeAudioError.unavailable }
            switch operation {
            case "now":
                let now = host.currentHostTimeMs()
                guard now.isFinite, now >= 0, now <= 9_007_199_254_740_991 else { throw NativeAudioError.invalidRequest }
                return JSValue(double: now, in: context)
            case "subscribe":
                guard callback == nil, let listener = args.atIndex(0), listener.isObject,
                      let function = JSValueToObject(context.jsGlobalContextRef, listener.jsValueRef, nil),
                      JSObjectIsFunction(context.jsGlobalContextRef, function), ticket < 9_007_199_254_740_991 else {
                    throw NativeAudioError.invalidRequest
                }
                ticket += 1; callback = listener
                let detach = try host.subscribe { [weak self] event in self?.forward(event) }
                guard !closed else { detach(); throw NativeAudioError.unavailable }
                unsubscribe = detach
                return JSValue(double: Double(ticket), in: context)
            case "unsubscribe":
                let requested = try number(args.atIndex(0), min: 1, integral: true)
                if UInt64(requested) == ticket { detach() }
            case "start":
                guard callback != nil else { throw NativeAudioError.unavailable }
                try host.start()
            case "enqueue":
                guard callback != nil, let value = args.atIndex(0), value.isObject else { throw NativeAudioError.unavailable }
                try enqueue(value)
            case "update":
                try host.updateEnvelope(id: identifier(args.atIndex(0)), gainCeiling: roundedGain(number(args.atIndex(1), max: 1)),
                    fadeStartMs: number(args.atIndex(2)), stopAtMs: number(args.atIndex(3)))
            case "cancel": host.cancel(id: try identifier(args.atIndex(0)))
            case "cancelAll": host.cancelAll()
            case "stop": host.stop()
            default: throw NativeAudioError.invalidRequest
            }
        } catch {
            close()
            // Never include caller-controlled messages, media or keys in errors.
            context.exception = JSValue(newErrorFromMessage: "NATIVE_AUDIO_BRIDGE_FAILURE", in: context)
        }
        return nil
    }
    private func forward(_ event: IOSHostEvent) {
        guard !closed, let context, let callback else { return }
        let payload: [String: Any]
        switch event {
        case let .routeActive(route, sampleRate, channels):
            payload = ["type": "route-active", "sampleRate": sampleRate, "maxChannels": channels,
                "route": ["endpointId": route.endpointId, "routeId": route.routeId, "outputId": route.outputId,
                          "kind": route.kind, "generation": Double(route.generation)]]
        case let .interrupted(reason): payload = ["type": "interrupted", "reason": reason]
        case .disconnected: payload = ["type": "disconnected"]
        case let .completed(id): payload = ["type": "completed", "id": id]
        }
        guard context.exception == nil else { close(); return }
        _ = callback.call(withArguments: [payload])
        if context.exception != nil { close() }
    }
    private func detach() {
        callback = nil
        let detach = unsubscribe; unsubscribe = nil
        detach?()
    }
    public func close() {
        guard !closed else { return }
        closed = true; detach(); host.close(); javascriptObject = nil
    }

    // Capture intrinsics before exposing the wrapper. Data descriptors only;
    // reject shared/resizable buffers and do not JSON/base64 encode private PCM.
    private static let factory = #"""
    (function(native) {
      'use strict';
      const descriptors = Object.getOwnPropertyDescriptors;
      const keys = Reflect.ownKeys;
      const freeze = Object.freeze;
      const arrayBufferSize = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get;
      const resizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
      const typedBuffer = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Float32Array.prototype), 'buffer').get;
      const call = (op, args) => native.invoke({op, args});
      function snapshot(input) {
        const ds = descriptors(input), names = keys(ds);
        if (names.some(key => typeof key !== 'string') || names.sort().join(',') !==
            'channels,fadeStartHostTimeMs,frames,gainCeiling,id,routeGeneration,sampleRate,samples,startAtHostTimeMs,stopAtHostTimeMs') throw Error('shape');
        const copy = Object.create(null);
        for (const key of names) {
          if (!('value' in ds[key])) throw Error('accessor');
          copy[key] = ds[key].value;
        }
        const buffer = typedBuffer.call(copy.samples);
        arrayBufferSize.call(buffer); // A SharedArrayBuffer is not an ArrayBuffer.
        if (resizable && resizable.call(buffer)) throw Error('resizable');
        return copy;
      }
      return freeze({
        subscribe(listener) {
          const ticket = call('subscribe', [listener]); let done = false;
          return () => { if (!done) { done = true; call('unsubscribe', [ticket]); } };
        },
        enqueue(request) {
          let copy;
          try { copy = snapshot(request); }
          catch (_) { call('fault', []); throw Error('INVALID_NATIVE_AUDIO_REQUEST'); }
          call('enqueue', [copy]);
        },
        updateEnvelope: (id, gain, fade, stop) => call('update', [id, gain, fade, stop]),
        cancel: id => call('cancel', [id]),
        cancelAll: () => call('cancelAll', []),
        nowHostTimeMs: () => call('now', []),
        start: () => call('start', []),
        stop: () => call('stop', []),
        close: () => call('close', [])
      });
    })
    """#
}
#endif
