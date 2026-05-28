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

public struct StreamRequest {
    public let streamUrl: String
    public let streamId: String
    public let keepAlive: Bool
    public let keepAliveIntervalSeconds: Int
    public let sound: Bool
    public let video: StreamVideoConfig?
    public let audio: StreamAudioConfig?
    public let extraValues: [String: Any]

    public init(
        streamUrl: String,
        streamId: String = "",
        keepAlive: Bool = true,
        keepAliveIntervalSeconds: Int = 15,
        sound: Bool = true,
        video: StreamVideoConfig? = nil,
        audio: StreamAudioConfig? = nil,
        extraValues: [String: Any] = [:]
    ) {
        self.streamUrl = streamUrl
        self.streamId = streamId
        self.keepAlive = keepAlive
        self.keepAliveIntervalSeconds = keepAliveIntervalSeconds
        self.sound = sound
        self.video = video
        self.audio = audio
        self.extraValues = extraValues
    }

    init(values: [String: Any]) {
        self.init(
            streamUrl: values["streamUrl"] as? String
                ?? values["rtmpUrl"] as? String
                ?? values["srtUrl"] as? String
                ?? values["whipUrl"] as? String
                ?? "",
            streamId: values["streamId"] as? String ?? "",
            keepAlive: values["keepAlive"] as? Bool ?? true,
            keepAliveIntervalSeconds: intValue(values["keepAliveIntervalSeconds"]) ?? 15,
            sound: values["sound"] as? Bool ?? true,
            video: StreamVideoConfig(values: values["video"] as? [String: Any]),
            audio: StreamAudioConfig(values: values["audio"] as? [String: Any]),
            extraValues: values
        )
    }

    public var values: [String: Any] {
        var values = extraValues
        values["type"] = "start_stream"
        values["streamUrl"] = streamUrl
        values["streamId"] = streamId
        values["keepAlive"] = keepAlive
        values["keepAliveIntervalSeconds"] = keepAliveIntervalSeconds
        // The camera light is a privacy indicator and cannot be disabled by SDK callers.
        values["flash"] = true
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

public struct StreamKeepAliveRequest {
    public let streamId: String
    public let ackId: String
    public let extraValues: [String: Any]

    public init(streamId: String, ackId: String, extraValues: [String: Any] = [:]) {
        self.streamId = streamId
        self.ackId = ackId
        self.extraValues = extraValues
    }

    init(values: [String: Any]) {
        self.init(
            streamId: values["streamId"] as? String ?? "",
            ackId: values["ackId"] as? String ?? "",
            extraValues: values
        )
    }

    public var values: [String: Any] {
        var values = extraValues
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
    case lifecycle(state: StreamState, streamId: String?, timestamp: Int?)
    case reconnecting(streamId: String?, attempt: Int, maxAttempts: Int, reason: String, timestamp: Int?)
    case reconnected(streamId: String?, attempt: Int, timestamp: Int?)
    case reconnectFailed(streamId: String?, maxAttempts: Int, timestamp: Int?)
    case error(streamId: String?, errorDetails: String, timestamp: Int?)
    case snapshot(state: StreamState, streaming: Bool, reconnecting: Bool, streamId: String?, attempt: Int?, timestamp: Int?)

    public init(values: [String: Any]) {
        let rawState = stringValue(values, "status")
        let streamId = stringValue(values, "streamId")
        let timestamp = intValue(values["timestamp"])
        let attempt = optionalIntValue(values, "attempt")
        let maxAttempts = optionalIntValue(values, "maxAttempts") ?? 0

        if hasAnyKey(values, "streaming") || hasAnyKey(values, "reconnecting") {
            let streaming = boolValue(values, "streaming") == true
            let reconnecting = boolValue(values, "reconnecting") == true
            let snapshotState: StreamState = reconnecting ? .reconnecting : (streaming ? .streaming : .stopped)
            self = .snapshot(
                state: snapshotState,
                streaming: streaming,
                reconnecting: reconnecting,
                streamId: streamId,
                attempt: attempt,
                timestamp: timestamp
            )
            return
        }

        guard let state = StreamState.from(rawState) else {
            self = .error(
                streamId: streamId,
                errorDetails: rawState.map { "Unknown stream status: \($0)" } ?? "Missing stream status",
                timestamp: timestamp
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
                timestamp: timestamp
            )
        case .reconnected:
            self = .reconnected(streamId: streamId, attempt: attempt ?? 0, timestamp: timestamp)
        case .reconnectFailed:
            self = .reconnectFailed(streamId: streamId, maxAttempts: maxAttempts, timestamp: timestamp)
        case .error:
            self = .error(
                streamId: streamId,
                errorDetails: stringValue(values, "errorDetails")
                    ?? (rawState == "error_not_streaming" ? "not_streaming" : "Unknown stream error"),
                timestamp: timestamp
            )
        default:
            self = .lifecycle(state: state, streamId: streamId, timestamp: timestamp)
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
        case let .lifecycle(state, _, _):
            state
        case .reconnecting:
            .reconnecting
        case .reconnected:
            .reconnected
        case .reconnectFailed:
            .reconnectFailed
        case .error:
            .error
        case let .snapshot(state, _, _, _, _, _):
            state
        }
    }

    public var streamId: String? {
        switch self {
        case let .lifecycle(_, streamId, _),
             let .reconnecting(streamId, _, _, _, _),
             let .reconnected(streamId, _, _),
             let .reconnectFailed(streamId, _, _),
             let .error(streamId, _, _),
             let .snapshot(_, _, _, streamId, _, _):
            streamId
        }
    }

    public var timestamp: Int? {
        switch self {
        case let .lifecycle(_, _, timestamp),
             let .reconnecting(_, _, _, _, timestamp),
             let .reconnected(_, _, timestamp),
             let .reconnectFailed(_, _, timestamp),
             let .error(_, _, timestamp),
             let .snapshot(_, _, _, _, _, timestamp):
            timestamp
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

        switch self {
        case .lifecycle:
            break
        case let .reconnecting(_, attempt, maxAttempts, reason, _):
            values["attempt"] = attempt
            values["maxAttempts"] = maxAttempts
            values["reason"] = reason
        case let .reconnected(_, attempt, _):
            values["attempt"] = attempt
        case let .reconnectFailed(_, maxAttempts, _):
            values["maxAttempts"] = maxAttempts
        case let .error(_, errorDetails, _):
            values["errorDetails"] = errorDetails
        case let .snapshot(_, streaming, reconnecting, _, attempt, _):
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
        self.status = StreamStatus(values: values)
    }

    public var state: StreamState {
        status.state
    }

    public var streamId: String? {
        status.streamId
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
        self.streamId = stringValue(values, "streamId") ?? ""
        self.ackId = stringValue(values, "ackId") ?? ""
        self.timestamp = intValue(values["timestamp"])
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
