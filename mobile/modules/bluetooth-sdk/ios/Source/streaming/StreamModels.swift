import Foundation

public struct StreamVideoConfig {
    public let width: Int?
    public let height: Int?
    public let bitrate: Int?
    public let fps: Int?

    public init(
        width: Int? = nil,
        height: Int? = nil,
        bitrate: Int? = nil,
        fps: Int? = nil
    ) {
        self.width = width
        self.height = height
        self.bitrate = bitrate
        self.fps = fps
    }

    var dictionary: [String: Any] {
        var values: [String: Any] = [:]
        if let width { values["width"] = width }
        if let height { values["height"] = height }
        if let bitrate { values["bitrate"] = bitrate }
        // ASG stream parsers shipped with the BLE key named "frameRate".
        if let fps { values["frameRate"] = fps }
        return values
    }

    init?(values: [String: Any]?) {
        guard let values else { return nil }
        self.init(
            width: intValue(values["width"]),
            height: intValue(values["height"]),
            bitrate: intValue(values["bitrate"]),
            fps: intValue(values["fps"])
        )
    }
}

public struct StreamAudioConfig {
    public let bitrate: Int?
    public let sampleRate: Int?
    public let echoCancellation: Bool?
    public let noiseSuppression: Bool?

    public init(
        bitrate: Int? = nil,
        sampleRate: Int? = nil,
        echoCancellation: Bool? = nil,
        noiseSuppression: Bool? = nil
    ) {
        self.bitrate = bitrate
        self.sampleRate = sampleRate
        self.echoCancellation = echoCancellation
        self.noiseSuppression = noiseSuppression
    }

    var dictionary: [String: Any] {
        var values: [String: Any] = [:]
        if let bitrate { values["bitrate"] = bitrate }
        if let sampleRate { values["sampleRate"] = sampleRate }
        if let echoCancellation { values["echoCancellation"] = echoCancellation }
        if let noiseSuppression { values["noiseSuppression"] = noiseSuppression }
        return values
    }

    init?(values: [String: Any]?) {
        guard let values else { return nil }
        self.init(
            bitrate: intValue(values["bitrate"]),
            sampleRate: intValue(values["sampleRate"]),
            echoCancellation: values["echoCancellation"] as? Bool,
            noiseSuppression: values["noiseSuppression"] as? Bool
        )
    }
}

/// Effective video settings reported by the glasses after defaults and clamps.
public struct StreamResolvedVideoConfig: Equatable {
    /// Encoded output width sent to the stream endpoint.
    public let width: Int
    /// Encoded output height sent to the stream endpoint.
    public let height: Int
    /// Native camera buffer width selected before crop/downscale.
    public let captureWidth: Int?
    /// Native camera buffer height selected before crop/downscale.
    public let captureHeight: Int?
    /// Encoded video bitrate in bits per second.
    public let bitrate: Int
    /// Resolved capture/encode frame rate.
    public let fps: Double

    public init(
        width: Int,
        height: Int,
        captureWidth: Int? = nil,
        captureHeight: Int? = nil,
        bitrate: Int,
        fps: Double
    ) {
        self.width = width
        self.height = height
        self.captureWidth = captureWidth
        self.captureHeight = captureHeight
        self.bitrate = bitrate
        self.fps = fps
    }

    init?(values: [String: Any]?) {
        guard let values,
              let width = intValue(values["width"]),
              let height = intValue(values["height"]),
              let bitrate = intValue(values["bitrate"]),
              let fps = doubleValue(values["fps"])
        else {
            return nil
        }
        self.init(
            width: width,
            height: height,
            captureWidth: intValue(values["captureWidth"]),
            captureHeight: intValue(values["captureHeight"]),
            bitrate: bitrate,
            fps: fps
        )
    }

    var values: [String: Any] {
        var values: [String: Any] = [
            "width": width,
            "height": height,
            "bitrate": bitrate,
            "fps": fps,
        ]
        if let captureWidth { values["captureWidth"] = captureWidth }
        if let captureHeight { values["captureHeight"] = captureHeight }
        return values
    }
}

public struct StreamResolvedAudioConfig: Equatable {
    public let bitrate: Int?
    public let sampleRate: Int?
    public let echoCancellation: Bool?
    public let noiseSuppression: Bool?

    public init(
        bitrate: Int? = nil,
        sampleRate: Int? = nil,
        echoCancellation: Bool? = nil,
        noiseSuppression: Bool? = nil
    ) {
        self.bitrate = bitrate
        self.sampleRate = sampleRate
        self.echoCancellation = echoCancellation
        self.noiseSuppression = noiseSuppression
    }

    init?(values: [String: Any]?) {
        guard let values else { return nil }
        self.init(
            bitrate: intValue(values["bitrate"]),
            sampleRate: intValue(values["sampleRate"]),
            echoCancellation: boolValue(values, "echoCancellation"),
            noiseSuppression: boolValue(values, "noiseSuppression")
        )
    }

    var values: [String: Any] {
        var values: [String: Any] = [:]
        if let bitrate { values["bitrate"] = bitrate }
        if let sampleRate { values["sampleRate"] = sampleRate }
        if let echoCancellation { values["echoCancellation"] = echoCancellation }
        if let noiseSuppression { values["noiseSuppression"] = noiseSuppression }
        return values
    }
}

public enum StreamTransport: String, Equatable {
    case rtmp
    case srt
    case whip
}

public struct StreamResolvedConfig: Equatable {
    public let transport: StreamTransport?
    public let video: StreamResolvedVideoConfig?
    public let audio: StreamResolvedAudioConfig?

    public init(
        transport: StreamTransport? = nil,
        video: StreamResolvedVideoConfig? = nil,
        audio: StreamResolvedAudioConfig? = nil
    ) {
        self.transport = transport
        self.video = video
        self.audio = audio
    }

    init?(values: [String: Any]?) {
        guard let values else { return nil }
        self.init(
            transport: stringValue(values, "transport").flatMap(StreamTransport.init(rawValue:)),
            video: StreamResolvedVideoConfig(values: values["video"] as? [String: Any]),
            audio: StreamResolvedAudioConfig(values: values["audio"] as? [String: Any])
        )
    }

    var values: [String: Any] {
        var values: [String: Any] = [:]
        if let transport { values["transport"] = transport.rawValue }
        if let video { values["video"] = video.values }
        if let audio { values["audio"] = audio.values }
        return values
    }
}

public struct StreamRequest {
    public let streamUrl: String
    public let streamId: String
    public let sound: Bool
    public let video: StreamVideoConfig?
    public let audio: StreamAudioConfig?

    public init(
        streamUrl: String,
        streamId: String = "",
        sound: Bool = true,
        video: StreamVideoConfig? = nil,
        audio: StreamAudioConfig? = nil
    ) {
        self.streamUrl = streamUrl
        self.streamId = streamId
        self.sound = sound
        self.video = video
        self.audio = audio
    }

    init(values: [String: Any]) {
        self.init(
            streamUrl: values["streamUrl"] as? String
                ?? values["rtmpUrl"] as? String
                ?? values["srtUrl"] as? String
                ?? values["whipUrl"] as? String
                ?? "",
            streamId: values["streamId"] as? String ?? "",
            sound: values["sound"] as? Bool ?? true,
            video: StreamVideoConfig(values: values["video"] as? [String: Any]),
            audio: StreamAudioConfig(values: values["audio"] as? [String: Any])
        )
    }

    public var values: [String: Any] {
        var values: [String: Any] = [:]
        values["type"] = "start_stream"
        values["streamUrl"] = streamUrl
        values["streamId"] = streamId
        values["sound"] = sound
        if let videoValues = video?.dictionary, !videoValues.isEmpty {
            values["video"] = videoValues
        }
        if let audioValues = audio?.dictionary, !audioValues.isEmpty {
            values["audio"] = audioValues
        }
        return values
    }
}

struct StreamKeepAliveRequest {
    let streamId: String
    let ackId: String

    init(streamId: String, ackId: String) {
        self.streamId = streamId
        self.ackId = ackId
    }

    init(values: [String: Any]) {
        self.init(
            streamId: values["streamId"] as? String ?? "",
            ackId: values["ackId"] as? String ?? ""
        )
    }

    var values: [String: Any] {
        var values: [String: Any] = [:]
        values["type"] = "keep_stream_alive"
        values["streamId"] = streamId
        values["ackId"] = ackId
        return values
    }
}

public enum StreamState: String, Equatable {
    case initializing
    case streaming
    case stopping
    case stopped
    case reconnecting
    case reconnected
    case reconnectFailed = "reconnect_failed"
    case error

    fileprivate static func from(_ value: String?) -> StreamState? {
        switch value?.lowercased() {
        case "initializing", "starting", "connecting":
            return .initializing
        case "streaming", "streaming_started", "active":
            return .streaming
        case "stopping":
            return .stopping
        case "stopped", "not_streaming", "disconnected", "timeout":
            return .stopped
        case "reconnecting":
            return .reconnecting
        case "reconnected":
            return .reconnected
        case "reconnect_failed":
            return .reconnectFailed
        case "error", "error_not_streaming":
            return .error
        default:
            return nil
        }
    }
}

public enum StreamStatusKind: String, Equatable {
    case lifecycle
    case reconnect
    case error
    case snapshot
}

public enum StreamStatus: CustomStringConvertible, Equatable {
    case lifecycle(state: StreamState, streamId: String?, timestamp: Int?, resolvedConfig: StreamResolvedConfig?)
    case reconnecting(
        streamId: String?,
        attempt: Int,
        maxAttempts: Int,
        reason: String,
        timestamp: Int?,
        resolvedConfig: StreamResolvedConfig?
    )
    case reconnected(streamId: String?, attempt: Int, timestamp: Int?, resolvedConfig: StreamResolvedConfig?)
    case reconnectFailed(streamId: String?, maxAttempts: Int, timestamp: Int?, resolvedConfig: StreamResolvedConfig?)
    case error(streamId: String?, errorDetails: String, timestamp: Int?, resolvedConfig: StreamResolvedConfig?)
    case snapshot(
        state: StreamState,
        streaming: Bool,
        reconnecting: Bool,
        streamId: String?,
        attempt: Int?,
        timestamp: Int?,
        resolvedConfig: StreamResolvedConfig?
    )

    public init(values: [String: Any]) {
        let rawState = stringValue(values, "status")
        let streamId = stringValue(values, "streamId")
        let timestamp = intValue(values["timestamp"])
        let resolvedConfig = StreamResolvedConfig(values: values["resolvedConfig"] as? [String: Any])
        let attempt = optionalIntValue(values, "attempt")
        let maxAttempts = optionalIntValue(values, "maxAttempts") ?? 0
        let parsedState = StreamState.from(rawState)

        if hasAnyKey(values, "streaming") || hasAnyKey(values, "reconnecting") {
            let streaming = boolValue(values, "streaming") == true
            let reconnecting = boolValue(values, "reconnecting") == true
            let snapshotState: StreamState
            if reconnecting {
                snapshotState = .reconnecting
            } else if streaming {
                snapshotState = .streaming
            } else {
                snapshotState = parsedState ?? .stopped
            }
            self = .snapshot(
                state: snapshotState,
                streaming: streaming,
                reconnecting: reconnecting,
                streamId: streamId,
                attempt: attempt,
                timestamp: timestamp,
                resolvedConfig: resolvedConfig
            )
            return
        }

        guard let state = parsedState else {
            self = .error(
                streamId: streamId,
                errorDetails: rawState.map { "Unknown stream status: \($0)" } ?? "Missing stream status",
                timestamp: timestamp,
                resolvedConfig: resolvedConfig
            )
            return
        }

        switch state {
        case .reconnecting:
            self = .reconnecting(
                streamId: streamId,
                attempt: attempt ?? 0,
                maxAttempts: maxAttempts,
                reason: stringValue(values, "reason") ?? "",
                timestamp: timestamp,
                resolvedConfig: resolvedConfig
            )
        case .reconnected:
            self = .reconnected(
                streamId: streamId,
                attempt: attempt ?? 0,
                timestamp: timestamp,
                resolvedConfig: resolvedConfig
            )
        case .reconnectFailed:
            self = .reconnectFailed(
                streamId: streamId,
                maxAttempts: maxAttempts,
                timestamp: timestamp,
                resolvedConfig: resolvedConfig
            )
        case .error:
            self = .error(
                streamId: streamId,
                errorDetails: stringValue(values, "errorDetails")
                    ?? (rawState == "error_not_streaming" ? "not_streaming" : "Unknown stream error"),
                timestamp: timestamp,
                resolvedConfig: resolvedConfig
            )
        default:
            self = .lifecycle(
                state: state,
                streamId: streamId,
                timestamp: timestamp,
                resolvedConfig: resolvedConfig
            )
        }
    }

    public var kind: StreamStatusKind {
        switch self {
        case .lifecycle:
            .lifecycle
        case .reconnecting, .reconnected, .reconnectFailed:
            .reconnect
        case .error:
            .error
        case .snapshot:
            .snapshot
        }
    }

    public var state: StreamState {
        switch self {
        case let .lifecycle(state, _, _, _):
            state
        case .reconnecting:
            .reconnecting
        case .reconnected:
            .reconnected
        case .reconnectFailed:
            .reconnectFailed
        case .error:
            .error
        case let .snapshot(state, _, _, _, _, _, _):
            state
        }
    }

    public var streamId: String? {
        switch self {
        case let .lifecycle(_, streamId, _, _),
             let .reconnecting(streamId, _, _, _, _, _),
             let .reconnected(streamId, _, _, _),
             let .reconnectFailed(streamId, _, _, _),
             let .error(streamId, _, _, _),
             let .snapshot(_, _, _, streamId, _, _, _):
            streamId
        }
    }

    public var timestamp: Int? {
        switch self {
        case let .lifecycle(_, _, timestamp, _),
             let .reconnecting(_, _, _, _, timestamp, _),
             let .reconnected(_, _, timestamp, _),
             let .reconnectFailed(_, _, timestamp, _),
             let .error(_, _, timestamp, _),
             let .snapshot(_, _, _, _, _, timestamp, _):
            timestamp
        }
    }

    public var resolvedConfig: StreamResolvedConfig? {
        switch self {
        case let .lifecycle(_, _, _, resolvedConfig),
             let .reconnecting(_, _, _, _, _, resolvedConfig),
             let .reconnected(_, _, _, resolvedConfig),
             let .reconnectFailed(_, _, _, resolvedConfig),
             let .error(_, _, _, resolvedConfig),
             let .snapshot(_, _, _, _, _, _, resolvedConfig):
            resolvedConfig
        }
    }

    public var values: [String: Any] {
        var values: [String: Any] = [
            "kind": kind.rawValue,
            "status": state.rawValue,
        ]
        if let streamId, !streamId.isEmpty {
            values["streamId"] = streamId
        }
        if let timestamp {
            values["timestamp"] = timestamp
        }
        if let resolvedConfig {
            values["resolvedConfig"] = resolvedConfig.values
        }

        switch self {
        case .lifecycle:
            break
        case let .reconnecting(_, attempt, maxAttempts, reason, _, _):
            values["attempt"] = attempt
            values["maxAttempts"] = maxAttempts
            values["reason"] = reason
        case let .reconnected(_, attempt, _, _):
            values["attempt"] = attempt
        case let .reconnectFailed(_, maxAttempts, _, _):
            values["maxAttempts"] = maxAttempts
        case let .error(_, errorDetails, _, _):
            values["errorDetails"] = errorDetails
        case let .snapshot(_, streaming, reconnecting, _, attempt, _, _):
            values["streaming"] = streaming
            values["reconnecting"] = reconnecting
            if let attempt {
                values["attempt"] = attempt
            }
        }

        return values
    }

    public var description: String {
        "StreamStatus(kind: \(kind.rawValue), status: \(state.rawValue), streamId: \(streamId ?? "none"))"
    }
}

public struct StreamStatusEvent: CustomStringConvertible {
    public let status: StreamStatus

    public init(status: StreamStatus) {
        self.status = status
    }

    public init(values: [String: Any]) {
        status = StreamStatus(values: values)
    }

    public var state: StreamState {
        status.state
    }

    public var streamId: String? {
        status.streamId
    }

    public var resolvedConfig: StreamResolvedConfig? {
        status.resolvedConfig
    }

    public var values: [String: Any] {
        var values = status.values
        values["type"] = "stream_status"
        return values
    }

    public var description: String {
        "StreamStatusEvent(kind: \(status.kind.rawValue), status: \(state.rawValue), streamId: \(streamId ?? "none"))"
    }
}

public struct KeepAliveAckEvent: CustomStringConvertible, Equatable {
    public let streamId: String
    public let ackId: String
    public let timestamp: Int?

    public init(streamId: String, ackId: String, timestamp: Int? = nil) {
        self.streamId = streamId
        self.ackId = ackId
        self.timestamp = timestamp
    }

    public init(values: [String: Any]) {
        streamId = stringValue(values, "streamId") ?? ""
        ackId = stringValue(values, "ackId") ?? ""
        timestamp = intValue(values["timestamp"])
    }

    public var values: [String: Any] {
        var values: [String: Any] = [
            "type": "keep_alive_ack",
            "streamId": streamId,
            "ackId": ackId,
        ]
        if let timestamp {
            values["timestamp"] = timestamp
        }
        return values
    }

    public var description: String {
        "KeepAliveAckEvent(streamId: \(streamId), ackId: \(ackId))"
    }
}
