import Foundation

/// Pure decision logic for the Mentra Live usage events: one event per photo,
/// recording, stream, mic session, setup attempt, OTA attempt and timed-out
/// glasses command. It owns no threads and no I/O; `BluetoothSdkAnalytics` feeds
/// it facts and captures what it returns, and only when analytics is enabled.
///
/// Durations are measured on the phone's clock between the start and end
/// statuses it observes. A recording or stream whose end never reaches this
/// process (the app was killed mid-stream) produces only its start.
struct BluetoothSdkUsageTracker {
    static let eventPhotoTaken = "bluetooth_sdk_photo_taken"
    static let eventVideoRecorded = "bluetooth_sdk_video_recorded"
    static let eventButtonPressed = "bluetooth_sdk_button_pressed"
    static let eventStreamStarted = "bluetooth_sdk_stream_started"
    static let eventStreamEnded = "bluetooth_sdk_stream_ended"
    static let eventMicSession = "bluetooth_sdk_mic_session"
    static let eventWifiSetup = "bluetooth_sdk_wifi_setup"
    static let eventHotspotStarted = "bluetooth_sdk_hotspot_started"
    static let eventOtaFinished = "bluetooth_sdk_ota_finished"
    static let eventRequestFailed = "bluetooth_sdk_request_failed"

    static let maxRequestTimeoutsDefault = 100
    /// Glasses report button-capture photo failures under this request id (ASG MediaCaptureService).
    static let localPhotoRequestId = "local"
    /// Button-started recordings use `local_video_<ts>_<rand>` request ids on the glasses.
    static let localVideoRequestPrefix = "local_video_"

    private static let maxOpenRecordings = 16
    private static let maxOtaSessions = 16
    private static let maxDetailLength = 200
    private static let triggerApi = "api"
    private static let triggerButton = "button"
    private static let otaComplete = "complete"
    private static let otaFailed = "failed"
    private static let otaIdle = "idle"
    private static let legacyTerminalStreamStates: Set<String> = ["stopped", "reconnect_failed"]
    private static let urlPattern = try! NSRegularExpression(pattern: #"[A-Za-z][A-Za-z0-9+.\-]*://\S+"#)

    private struct OpenRecording {
        var startedAtMs: Int64?
        var width: Int?
        var height: Int?
        var fps: Int?
        var save: Bool?
        var maxDurationMinutes: Int?
        var stoppedByApp = false
    }

    private struct OpenStream {
        let streamId: String
        let streamProtocol: String
        let startedAtMs: Int64
        var reconnectAttempts = 0
        var stoppedByApp = false
        var bitrate: Int64?
        var fps: Double?
        var droppedFrames: Int64?
        var temperatureC: Double?
    }

    private struct OpenOta {
        let startedAtMs: Int64
        let fromBuildNumber: String
        let fromBesFirmwareVersion: String
        let fromMtkFirmwareVersion: String
    }

    private let maxRequestTimeouts: Int
    private var recordings = BoundedMap<String, OpenRecording>(capacity: BluetoothSdkUsageTracker.maxOpenRecordings)
    private var stream: OpenStream?
    private var micSource: String?
    private var micStartedAtMs: Int64 = 0
    private var micTranscribed = false
    private var otaSessions = BoundedMap<String, OpenOta>(capacity: BluetoothSdkUsageTracker.maxOtaSessions)
    private var finishedOtaSessions = BoundedMap<String, Bool>(capacity: BluetoothSdkUsageTracker.maxOtaSessions)
    private var requestTimeouts = 0

    init(maxRequestTimeouts: Int = BluetoothSdkUsageTracker.maxRequestTimeoutsDefault) {
        self.maxRequestTimeouts = maxRequestTimeouts
    }

    func photoSettled(
        size: String,
        mode: String,
        compress: String,
        save: Bool,
        transferMethod: String,
        latencyMs: Int64,
        fileSizeBytes: Int64?,
        errorCode: String?
    ) -> AnalyticsEvent {
        var properties: [String: Any] = ["trigger": Self.triggerApi]
        Self.putOutcome(&properties, errorCode)
        properties["latency_ms"] = latencyMs
        properties["photo_size"] = size
        properties["photo_mode"] = mode
        properties["compress"] = compress
        properties["save_to_gallery"] = save
        properties["transfer_method"] = transferMethod
        if let fileSizeBytes, fileSizeBytes > 0 { properties["file_size_bytes"] = fileSizeBytes }
        return AnalyticsEvent(name: Self.eventPhotoTaken, properties: properties)
    }

    /// A button photo the glasses could not take; successful button photos never reach the phone.
    func buttonPhotoFailed(errorCode: String?) -> AnalyticsEvent {
        var properties: [String: Any] = ["trigger": Self.triggerButton]
        Self.putOutcome(&properties, errorCode ?? "photo_request_failed")
        return AnalyticsEvent(name: Self.eventPhotoTaken, properties: properties)
    }

    func buttonPressed(buttonId: String, pressType: String, galleryModeEnabled: Bool) -> AnalyticsEvent {
        AnalyticsEvent(
            name: Self.eventButtonPressed,
            properties: [
                "button_id": buttonId,
                "press_type": pressType,
                "gallery_mode_enabled": galleryModeEnabled,
            ]
        )
    }

    /// Records the API parameters of a recording so its end event can report them.
    mutating func videoRequested(requestId: String, width: Int, height: Int, fps: Int, save: Bool, maxDurationMinutes: Int) {
        recordings[requestId] = OpenRecording(
            width: width > 0 ? width : nil,
            height: height > 0 ? height : nil,
            fps: fps > 0 ? fps : nil,
            save: save,
            maxDurationMinutes: maxDurationMinutes > 0 ? maxDurationMinutes : nil
        )
    }

    mutating func videoStopRequested(requestId: String) {
        guard var recording = recordings[requestId] else { return }
        recording.stoppedByApp = true
        recordings[requestId] = recording
    }

    /// Glasses report every recording, button-started ones included, through
    /// `video_recording_status`. A recording is reported once: when it stops, or
    /// when a command for it fails. `not_recording` answers a stop for a recording
    /// that already ended and is not a recording of its own.
    mutating func videoStatus(requestId: String, status: String, success: Bool, nowMs: Int64) -> AnalyticsEvent? {
        guard !requestId.isBlank else { return nil }
        if success {
            switch status {
            case "recording_started":
                var recording = recordings[requestId] ?? OpenRecording()
                if recording.startedAtMs == nil { recording.startedAtMs = nowMs }
                recordings[requestId] = recording
                return nil
            case "recording_stopped":
                guard let recording = recordings.removeValue(forKey: requestId) else { return nil }
                return videoEvent(requestId: requestId, recording: recording, nowMs: nowMs, errorCode: nil)
            default:
                return nil
            }
        }
        if status == "not_recording" {
            recordings.removeValue(forKey: requestId)
            return nil
        }
        let recording = recordings.removeValue(forKey: requestId) ?? OpenRecording()
        return videoEvent(
            requestId: requestId,
            recording: recording,
            nowMs: nowMs,
            errorCode: status.isBlank ? "video_recording_failed" : status
        )
    }

    private func videoEvent(requestId: String, recording: OpenRecording, nowMs: Int64, errorCode: String?) -> AnalyticsEvent {
        var properties: [String: Any] = [
            "trigger": requestId.hasPrefix(Self.localVideoRequestPrefix) ? Self.triggerButton : Self.triggerApi,
        ]
        Self.putOutcome(&properties, errorCode)
        if let startedAtMs = recording.startedAtMs { properties["duration_ms"] = max(nowMs - startedAtMs, 0) }
        if let width = recording.width { properties["width"] = width }
        if let height = recording.height { properties["height"] = height }
        if let fps = recording.fps { properties["fps"] = fps }
        if let save = recording.save { properties["save_to_gallery"] = save }
        if let maxDurationMinutes = recording.maxDurationMinutes { properties["max_duration_minutes"] = maxDurationMinutes }
        properties["stopped_by_app"] = recording.stoppedByApp
        return AnalyticsEvent(name: Self.eventVideoRecorded, properties: properties)
    }

    mutating func streamStartSettled(
        streamId: String,
        streamUrl: String,
        width: Int?,
        height: Int?,
        fps: Int?,
        bitrate: Int?,
        captureAudio: Bool,
        glassesNetwork: String,
        latencyMs: Int64,
        errorCode: String?,
        nowMs: Int64
    ) -> AnalyticsEvent {
        let streamProtocol = Self.streamProtocol(streamUrl)
        if errorCode == nil {
            stream = OpenStream(streamId: streamId, streamProtocol: streamProtocol, startedAtMs: nowMs)
        }
        var properties: [String: Any] = [:]
        Self.putOutcome(&properties, errorCode)
        properties["protocol"] = streamProtocol
        if let width { properties["width"] = width }
        if let height { properties["height"] = height }
        if let fps { properties["fps"] = fps }
        if let bitrate { properties["bitrate"] = bitrate }
        properties["capture_audio"] = captureAudio
        properties["glasses_network"] = glassesNetwork
        properties["latency_ms"] = latencyMs
        return AnalyticsEvent(name: Self.eventStreamStarted, properties: properties)
    }

    mutating func streamStopRequested() {
        stream?.stoppedByApp = true
    }

    /// Folds one accepted `stream_status` into the open stream and reports the
    /// stream once, on its terminal status. Glasses with stream revisions flag the
    /// terminal status; older glasses only send a final `stopped` or
    /// `reconnect_failed`.
    mutating func streamStatus(
        streamId: String?,
        state: String,
        terminal: Bool?,
        reconnectAttempt: Int?,
        bitrate: Int64?,
        fps: Double?,
        droppedFrames: Int64?,
        temperatureC: Double?,
        errorDetails: String?,
        nowMs: Int64
    ) -> AnalyticsEvent? {
        guard var open = stream else { return nil }
        if let streamId, !streamId.isBlank, streamId != open.streamId { return nil }
        if let reconnectAttempt { open.reconnectAttempts = max(open.reconnectAttempts, reconnectAttempt) }
        if let bitrate { open.bitrate = bitrate }
        if let fps { open.fps = fps }
        if let droppedFrames { open.droppedFrames = droppedFrames }
        if let temperatureC { open.temperatureC = temperatureC }
        let ended = terminal == true || (terminal == nil && Self.legacyTerminalStreamStates.contains(state))
        guard ended else {
            stream = open
            return nil
        }
        stream = nil
        var properties: [String: Any] = [
            "protocol": open.streamProtocol,
            "duration_ms": max(nowMs - open.startedAtMs, 0),
            "end_state": state,
            "stopped_by_app": open.stoppedByApp,
            "reconnect_attempts": open.reconnectAttempts,
        ]
        if let detail = Self.sanitizedDetail(errorDetails) { properties["error_code"] = detail }
        if let bitrate = open.bitrate { properties["bitrate"] = bitrate }
        if let fps = open.fps { properties["fps"] = fps }
        if let droppedFrames = open.droppedFrames { properties["dropped_frames"] = droppedFrames }
        if let temperatureC = open.temperatureC { properties["temperature_c"] = temperatureC }
        return AnalyticsEvent(name: Self.eventStreamEnded, properties: properties)
    }

    /// Follows the active mic source. A session ends when the source turns off or
    /// changes; `local_transcription` is true if on-device transcription ran at
    /// any point during it.
    mutating func observeMic(currentMic: String, transcribing: Bool, nowMs: Int64) -> AnalyticsEvent? {
        let next: String? = currentMic.isBlank ? nil : currentMic
        let previous = micSource
        if next == previous {
            if next != nil, transcribing { micTranscribed = true }
            return nil
        }
        let ended = previous.map {
            AnalyticsEvent(
                name: Self.eventMicSession,
                properties: [
                    "duration_ms": max(nowMs - micStartedAtMs, 0),
                    "mic_source": $0,
                    "local_transcription": micTranscribed,
                ]
            )
        }
        micSource = next
        micStartedAtMs = nowMs
        micTranscribed = next != nil && transcribing
        return ended
    }

    func wifiSetupSettled(latencyMs: Int64, errorCode: String?) -> AnalyticsEvent {
        var properties: [String: Any] = [:]
        Self.putOutcome(&properties, errorCode)
        properties["latency_ms"] = latencyMs
        return AnalyticsEvent(name: Self.eventWifiSetup, properties: properties)
    }

    func hotspotStartSettled(latencyMs: Int64, errorCode: String?) -> AnalyticsEvent {
        var properties: [String: Any] = [:]
        Self.putOutcome(&properties, errorCode)
        properties["latency_ms"] = latencyMs
        return AnalyticsEvent(name: Self.eventHotspotStarted, properties: properties)
    }

    /// One event per OTA session, on `complete` or `failed`. The "from" versions are
    /// the glasses versions when this process first saw the session in progress.
    mutating func otaStatus(
        sessionId: String,
        status: String,
        stepType: String,
        totalSteps: Int,
        errorMessage: String?,
        fromBuildNumber: String,
        fromBesFirmwareVersion: String,
        fromMtkFirmwareVersion: String,
        nowMs: Int64
    ) -> AnalyticsEvent? {
        if finishedOtaSessions.contains(sessionId) { return nil }
        if status != Self.otaComplete, status != Self.otaFailed {
            if status != Self.otaIdle, !otaSessions.contains(sessionId) {
                otaSessions[sessionId] = OpenOta(
                    startedAtMs: nowMs,
                    fromBuildNumber: fromBuildNumber,
                    fromBesFirmwareVersion: fromBesFirmwareVersion,
                    fromMtkFirmwareVersion: fromMtkFirmwareVersion
                )
            }
            return nil
        }
        finishedOtaSessions[sessionId] = true
        let open = otaSessions.removeValue(forKey: sessionId)
        let success = status == Self.otaComplete
        var properties: [String: Any] = ["success": success]
        if !success {
            if !stepType.isBlank { properties["failed_step_type"] = stepType }
            if let detail = Self.sanitizedDetail(errorMessage) { properties["error_message"] = detail }
        }
        if totalSteps > 0 { properties["total_steps"] = totalSteps }
        if let open {
            properties["duration_ms"] = max(nowMs - open.startedAtMs, 0)
            if !open.fromBuildNumber.isBlank { properties["from_build_number"] = open.fromBuildNumber }
            if !open.fromBesFirmwareVersion.isBlank { properties["from_bes_firmware_version"] = open.fromBesFirmwareVersion }
            if !open.fromMtkFirmwareVersion.isBlank { properties["from_mtk_firmware_version"] = open.fromMtkFirmwareVersion }
        }
        return AnalyticsEvent(name: Self.eventOtaFinished, properties: properties)
    }

    /// At most `maxRequestTimeouts` per SDK instance, so a failure loop cannot run up event volume.
    mutating func requestTimedOut(operation: String) -> AnalyticsEvent? {
        guard requestTimeouts < maxRequestTimeouts else { return nil }
        requestTimeouts += 1
        return AnalyticsEvent(
            name: Self.eventRequestFailed,
            properties: ["operation": operation, "error_code": "request_timeout"]
        )
    }

    /// Mirrors the glasses' scheme mapping in ASG StreamCommandHandler.
    static func streamProtocol(_ streamUrl: String) -> String {
        let trimmed = streamUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let separator = trimmed.range(of: "://") else { return "unknown" }
        switch trimmed[..<separator.lowerBound].lowercased() {
        case "srt": return "srt"
        case "rtmp", "rtmps": return "rtmp"
        case "http", "https": return "whip"
        default: return "unknown"
        }
    }

    /// Free-text details may carry stream or upload URLs; those never leave the phone.
    static func sanitizedDetail(_ value: String?) -> String? {
        guard let value else { return nil }
        let range = NSRange(value.startIndex..., in: value)
        let replaced = urlPattern.stringByReplacingMatches(in: value, range: range, withTemplate: "<url>")
        let trimmed = replaced.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return String(trimmed.prefix(maxDetailLength))
    }

    private static func putOutcome(_ properties: inout [String: Any], _ errorCode: String?) {
        properties["success"] = errorCode == nil
        if let detail = sanitizedDetail(errorCode) { properties["error_code"] = detail }
    }
}

/// Insertion-ordered map that drops its oldest entry beyond `capacity`, so a
/// stream of ids whose end never arrives cannot grow without bound.
private struct BoundedMap<Key: Hashable, Value> {
    private let capacity: Int
    private var order: [Key] = []
    private var storage: [Key: Value] = [:]

    init(capacity: Int) {
        self.capacity = capacity
    }

    func contains(_ key: Key) -> Bool {
        storage[key] != nil
    }

    subscript(key: Key) -> Value? {
        get { storage[key] }
        set {
            guard let newValue else {
                removeValue(forKey: key)
                return
            }
            if storage.updateValue(newValue, forKey: key) == nil {
                order.append(key)
                if order.count > capacity {
                    storage.removeValue(forKey: order.removeFirst())
                }
            }
        }
    }

    @discardableResult
    mutating func removeValue(forKey key: Key) -> Value? {
        guard let removed = storage.removeValue(forKey: key) else { return nil }
        order.removeAll { $0 == key }
        return removed
    }
}
