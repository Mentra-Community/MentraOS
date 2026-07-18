//
//  Bridge.swift
//  AOS
//
//  Created by Matthew Fosse on 3/4/25.
//

import Foundation

/// Bridge for Bluetooth SDK communication between Expo modules and native iOS code
/// Has commands for the Bluetooth SDK to use to send messages to JavaScript
class Bridge {
    private static let micSampleRate = 16000
    private static let pcmBitsPerSample = 16
    private static let micChannels = 1
    private static let lc3FrameDurationMs = 10
    private static let defaultLc3FrameSizeBytes = 60
    private static let audioTraceMetadataKeys = [
        "sampleRate",
        "bitsPerSample",
        "channels",
        "encoding",
        "frameDurationMs",
        "frameSizeBytes",
        "bitrate",
        "packetizedFromGlasses",
        "voiceActivityDetectionEnabled",
    ]
    private static let eventSinkLock = NSLock()
    private static let defaultEventSinkId = "default"
    private static var eventSinks: [String: (String, [String: Any]) -> Void] = [:]

    static func initialize(callback: @escaping (String, [String: Any]) -> Void) {
        setEventSink(defaultEventSinkId, callback)
    }

    static func addEventSink(callback: @escaping (String, [String: Any]) -> Void) -> String {
        let id = UUID().uuidString
        setEventSink(id, callback)
        return id
    }

    static func removeEventSink(_ id: String) {
        eventSinkLock.lock()
        eventSinks.removeValue(forKey: id)
        eventSinkLock.unlock()
    }

    private static func setEventSink(_ id: String, _ callback: @escaping (String, [String: Any]) -> Void) {
        eventSinkLock.lock()
        eventSinks[id] = callback
        eventSinkLock.unlock()
    }

    private static func currentEventSinks() -> [(String, [String: Any]) -> Void] {
        eventSinkLock.lock()
        let sinks = Array(eventSinks.values)
        eventSinkLock.unlock()
        return sinks
    }

    /// Thread-safe event dispatch - ensures callback is invoked on main thread
    /// to avoid React Native bridge threading issues that can cause EXC_BREAKPOINT
    private static func dispatchEvent(_ eventName: String, _ data: [String: Any]) {
        let sinks = currentEventSinks()
        guard !sinks.isEmpty else { return }
        if Thread.isMainThread {
            sinks.forEach { $0(eventName, data) }
        } else {
            DispatchQueue.main.async {
                sinks.forEach { $0(eventName, data) }
            }
        }
    }

    static func log(_ message: String) {
        let data = ["message": message]
        Bridge.sendTypedMessage("log", body: data)
    }

    /// Report tar.bz2 extraction progress to JavaScript.
    static func sendExtractionProgress(percentage: Int, bytesRead: Int64, totalBytes: Int64) {
        let body: [String: Any] = [
            "percentage": percentage,
            "bytesRead": bytesRead,
            "totalBytes": totalBytes,
        ]
        Bridge.sendTypedMessage("extraction_progress", body: body)
    }

    static func sendHeadUp(_ isUp: Bool) {
        let data = ["up": isUp]
        Bridge.sendTypedMessage("head_up", body: data)
    }

    static func sendPairFailureEvent(_ error: String) {
        let data = ["error": error]
        Bridge.sendTypedMessage("pair_failure", body: data)
    }

    @MainActor
    static func sendMicPcm(_ data: Data) {
        Bridge.sendTypedMessage("mic_pcm", body: micPcmEventBody(data))
    }

    @MainActor
    static func sendMicLc3(_ data: Data) {
        Bridge.sendTypedMessage("mic_lc3", body: micLc3EventBody(data))
    }

    @MainActor
    private static func micPcmEventBody(_ data: Data) -> [String: Any] {
        let voiceActivityDetectionEnabled =
            DeviceStore.shared.get("glasses", "voiceActivityDetectionEnabled") as? Bool
                ?? BluetoothSdkDefaults.voiceActivityDetectionEnabled
        return [
            "pcm": data,
            "sampleRate": micSampleRate,
            "bitsPerSample": pcmBitsPerSample,
            "channels": micChannels,
            "encoding": "pcm_s16le",
            "voiceActivityDetectionEnabled": voiceActivityDetectionEnabled,
        ]
    }

    @MainActor
    private static func micLc3EventBody(_ data: Data) -> [String: Any] {
        let voiceActivityDetectionEnabled =
            DeviceStore.shared.get("glasses", "voiceActivityDetectionEnabled") as? Bool
                ?? BluetoothSdkDefaults.voiceActivityDetectionEnabled
        let frameSizeBytes = DeviceStore.shared.get("bluetooth", "lc3_frame_size") as? Int ?? defaultLc3FrameSizeBytes
        return [
            "lc3": data,
            "sampleRate": micSampleRate,
            "channels": micChannels,
            "encoding": "lc3",
            "frameDurationMs": lc3FrameDurationMs,
            "frameSizeBytes": frameSizeBytes,
            "bitrate": frameSizeBytes * 8 * (1000 / lc3FrameDurationMs),
            "packetizedFromGlasses": false,
            "voiceActivityDetectionEnabled": voiceActivityDetectionEnabled,
        ]
    }

    static func saveSetting(_ key: String, _ value: Any) {
        let body = ["key": key, "value": value]
        Bridge.sendTypedMessage("save_setting", body: body)
    }

    @MainActor
    static func sendVoiceActivityDetectionStatus(_ enabled: Bool) {
        DeviceStore.shared.set("glasses", "voiceActivityDetectionEnabled", enabled)
        let body: [String: Any] = [
            "voiceActivityDetectionEnabled": enabled,
        ]
        Bridge.sendTypedMessage("voice_activity_detection_status", body: body)
    }

    static func sendSpeakingStatus(_ speaking: Bool) {
        let body: [String: Any] = [
            "speaking": speaking,
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        ]
        Bridge.sendTypedMessage("speaking_status", body: body)
    }

    static func sendBatteryStatus(level: Int, charging: Bool) {
        let body: [String: Any] = [
            "level": level,
            "charging": charging,
            "timestamp": Date().timeIntervalSince1970 * 1000,
        ]
        Bridge.sendTypedMessage("battery_status", body: body)
    }

    static func sendDiscoveredDevice(
        _ deviceModel: String,
        _ deviceName: String,
        deviceAddress: String = "",
        rssi: Int? = nil
    ) {
        Task {
            await MainActor.run {
                let searchResults = DeviceStore.shared.get("bluetooth", "searchResults") as? [[String: Any]] ?? []
                let id = "\(deviceModel):\(deviceName)"
                var newResult: [String: Any] = [
                    "id": id,
                    "model": deviceModel,
                    "name": deviceName,
                ]
                if !deviceAddress.isEmpty {
                    newResult["address"] = deviceAddress
                }
                if let rssi {
                    newResult["rssi"] = rssi
                }
                // Keep the public searchResults array stable as glasses are added or removed.
                // Duplicate discoveries refresh their existing row; only new glasses append.
                let uniqueResults = mergeStableSearchResults(
                    searchResults,
                    newResult: newResult,
                    fallbackModel: deviceModel
                )
                DeviceStore.shared.set("bluetooth", "searchResults", uniqueResults)
            }
        }
    }

    private static func mergeStableSearchResults(
        _ currentResults: [[String: Any]],
        newResult: [String: Any],
        fallbackModel: String
    ) -> [[String: Any]] {
        guard let newKey = searchResultKey(newResult, fallbackModel: fallbackModel) else {
            return currentResults
        }
        var nextResults = currentResults
        if let existingIndex = nextResults.firstIndex(where: {
            searchResultKey($0, fallbackModel: fallbackModel) == newKey
        }) {
            nextResults[existingIndex] = newResult
        } else {
            nextResults.append(newResult)
        }
        return nextResults
    }

    private static func searchResultKey(_ result: [String: Any], fallbackModel: String) -> String? {
        if let id = result["id"] as? String, !id.isEmpty {
            return id
        }
        let model = result["model"] as? String ?? fallbackModel
        guard let name = result["name"] as? String else {
            return nil
        }
        return "\(model):\(name)"
    }

    // MARK: - Hardware Events

    static func sendButtonPress(buttonId: String, pressType: String) {
        // Send as typed message so it gets handled locally by MantleBridge.tsx
        // This allows the React Native layer to process it before forwarding to server
        let body: [String: Any] = [
            "buttonId": buttonId,
            "pressType": pressType,
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        ]
        Bridge.sendTypedMessage("button_press", body: body)
    }

    static func sendTouchEvent(deviceModel: String, gestureName: String, timestamp: Int64, source: Int32? = nil) {
        var body: [String: Any] = [
            "type": "touch_event",
            "deviceModel": deviceModel,
            "gestureName": gestureName,
            "timestamp": timestamp,
        ]
        if let source {
            body["source"] = source
        }
        Bridge.sendTypedMessage("touch_event", body: body)
    }

    static func sendAccelEvent(x: Float, y: Float, z: Float, timestamp: Int64) {
        let body: [String: Any] = [
            "x": x,
            "y": y,
            "z": z,
            "timestamp": timestamp,
        ]
        Bridge.sendTypedMessage("accel_event", body: body)
    }

    static func sendSwipeVolumeStatus(enabled: Bool, timestamp: Int64) {
        let body: [String: Any] = [
            "enabled": enabled,
            "timestamp": timestamp,
        ]
        Bridge.sendTypedMessage("swipe_volume_status", body: body)
    }

    static func sendSwitchStatus(switchType: Int, value: Int, timestamp: Int64) {
        let body: [String: Any] = [
            "switchType": switchType,
            "switchValue": value,
            "timestamp": timestamp,
        ]
        Bridge.sendTypedMessage("switch_status", body: body)
    }

    static func sendRgbLedControlResponse(requestId: String, success: Bool, error: String?) {
        guard !requestId.isEmpty else { return }
        var body: [String: Any] = [
            "type": "rgb_led_control_response",
            "requestId": requestId,
            "state": success ? "success" : "error",
        ]
        if !success {
            body["errorCode"] = error ?? "unknown_error"
        }
        Bridge.sendTypedMessage("rgb_led_control_response", body: body)
    }

    static func sendSettingsAck(_ values: [String: Any]) {
        var body = values
        body["type"] = "settings_ack"
        Bridge.sendTypedMessage("settings_ack", body: body)
    }

    static func sendVideoRecordingStatus(_ values: [String: Any]) {
        var body = values
        body["type"] = "video_recording_status"
        Bridge.sendTypedMessage("video_recording_status", body: body)
    }

    static func sendMediaUploadEvent(type: String, values: [String: Any]) {
        var body = values
        body["type"] = type
        Bridge.sendTypedMessage(type, body: body)
    }

    static func sendVersionInfo(_ values: [String: Any]) {
        var body: [String: Any] = [
            "type": "version_info",
            "androidVersion": stringValue(values, "androidVersion", "android_version") ?? "",
            "firmwareVersion": stringValue(values, "firmwareVersion", "firmware_version") ?? "",
            "besFirmwareVersion": stringValue(values, "besFirmwareVersion", "bes_fw_version") ?? "",
            "mtkFirmwareVersion": stringValue(values, "mtkFirmwareVersion", "mtk_fw_version") ?? "",
            "buildNumber": stringValue(values, "buildNumber", "build_number") ?? "",
            "otaVersionUrl": stringValue(values, "otaVersionUrl", "ota_version_url") ?? "",
            "appVersion": stringValue(values, "appVersion", "app_version") ?? "",
        ]
        if let systemTimeMs = intValue(values["systemTimeMs"]) ?? intValue(values["system_time_ms"]) {
            body["systemTimeMs"] = systemTimeMs
        }
        Bridge.sendTypedMessage("version_info", body: body)
    }

    static func sendPhotoError(requestId: String, errorCode: String, errorMessage: String) {
        let timestamp = Int(Date().timeIntervalSince1970 * 1000)
        var event: [String: Any] = [
            "type": "photo_response",
            "state": "error",
            "requestId": requestId,
            "timestamp": timestamp,
        ]
        if !errorCode.isEmpty {
            event["errorCode"] = errorCode
        }
        if !errorMessage.isEmpty {
            event["errorMessage"] = errorMessage
        }
        Bridge.sendTypedMessage("photo_response", body: event)
    }

    static func sendPhotoStatus(_ status: [String: Any]) {
        Bridge.sendTypedMessage("photo_status", body: status)
    }

    static func sendCameraStatus(_ status: [String: Any]) {
        Bridge.sendTypedMessage("camera_status", body: status)
    }

    static func sendPhotoResponse(_ response: [String: Any]) {
        Bridge.sendTypedMessage("photo_response", body: response)
    }

    static func sendMiniappSelected(packageName: String) {
        let event: [String: Any] = [
            "packageName": packageName,
        ]
        Bridge.sendTypedMessage("miniapp_selected", body: event)
    }

    /**
     * Send transcription result to server
     * Used by AOSManager to send pre-formatted transcription results
     * Matches the Java ServerComms structure exactly
     */
    static func sendLocalTranscription(transcription: [String: Any]) {
        guard let text = transcription["text"] as? String, !text.isEmpty else {
            Bridge.log("Skipping empty transcription result")
            return
        }

        Bridge.sendTypedMessage("local_transcription", body: transcription)
    }

    // Bluetooth SDK bridge funcs:

    static func sendserialNumber(_ serialNumber: String, style: String, color: String) {
        let body = [
            "glasses_serial_number": [
                "serial_number": serialNumber,
                "style": style,
                "color": color,
            ],
        ]
        Bridge.sendTypedMessage("glasses_serial_number", body: body)
    }

    /// `error` is the glasses' provisioning failure reason (e.g. "connect_timeout",
    /// "connected_to_other_network") when this status is the verdict of a failed
    /// connect attempt; nil for routine link-state updates.
    static func sendWifiStatusChange(connected: Bool, ssid: String?, localIp: String?, error: String? = nil) {
        guard let status = WifiStatus.fromStoreFields(
            connected: connected,
            ssid: ssid,
            localIp: localIp
        ) else {
            return
        }
        var body = status.values
        if let error {
            body["error"] = error
        }
        Bridge.sendTypedMessage("wifi_status_change", body: body)
    }

    /// Claim the WiFi scan-results store for a newly requested scan. Called by the
    /// SDK when it generates the scanId, BEFORE the scan command goes out: store
    /// ownership is decided at request time, not by whichever chunk arrives first,
    /// so a delayed chunk from an older, abandoned scan can never reset or clobber
    /// the current scan's accumulator.
    @MainActor
    static func claimWifiScanResults(scanId: String) {
        DeviceStore.shared.apply("bluetooth", "wifiScanActiveScanId", scanId)
    }

    static func updateWifiScanResults(
        _ networks: [[String: Any]],
        scanComplete: Bool,
        scanId: String? = nil
    ) {
        // Correlated scans accumulate chunks until the terminal scan_complete, so
        // chunks must reach the SDK in receive order. A Task per message can reach
        // the MainActor out of creation order; DispatchQueue.main keeps the FIFO
        // order of the serial bluetooth queue that delivers these.
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                // Only chunks echoing the active scanId claimed at request time may
                // mutate the store; foreign chunks are still forwarded to the SDK
                // sink, which drops stale ids itself. Scan-id-less chunks (old
                // firmware) keep the legacy accumulate-forever store behavior.
                let ownsStore: Bool
                if let scanId {
                    ownsStore =
                        scanId == DeviceStore.shared.get("bluetooth", "wifiScanActiveScanId") as? String
                } else {
                    ownsStore = true
                }
                var updatedNetworks: [[String: Any]] = networks
                if ownsStore {
                    var storedNetworks: [[String: Any]] =
                        DeviceStore.shared.get("bluetooth", "wifiScanResults") as? [[String: Any]] ?? []
                    if let scanId,
                       scanId != DeviceStore.shared.get("bluetooth", "wifiScanResultsScanId") as? String
                    {
                        // First chunk of a new scan: drop networks accumulated for a previous scan
                        // so stale entries never carry over into this scan's store.
                        storedNetworks = []
                        DeviceStore.shared.apply("bluetooth", "wifiScanResultsScanId", scanId)
                    }
                    // add the networks to the storedNetworks array, removing duplicates by ssid
                    for network in networks {
                        if !storedNetworks.contains(where: {
                            $0["ssid"] as? String == network["ssid"] as? String
                        }) {
                            storedNetworks.append(network)
                        }
                    }
                    DeviceStore.shared.apply("bluetooth", "wifiScanResults", storedNetworks)
                    updatedNetworks = storedNetworks
                }
                // Correlated scans: the SDK accumulates and dedupes chunks per scanId itself,
                // so forward only this chunk; the merged store list is for UI consumers.
                var body: [String: Any] = [
                    "networks": scanId != nil ? networks : updatedNetworks,
                    "scanComplete": scanComplete,
                ]
                if let scanId {
                    body["scanId"] = scanId
                }
                Bridge.sendTypedMessage("wifi_scan_result", body: body)
            }
        }
    }

    static func sendMtkUpdateComplete(message: String, timestamp: Int64) {
        let eventBody: [String: Any] = [
            "message": message,
            "timestamp": timestamp,
        ]
        Bridge.sendTypedMessage("mtk_update_complete", body: eventBody)
    }

    /// Send ota_start_ack — glasses confirmed receipt of ota_start command
    static func sendOtaStartAck() {
        let eventBody: [String: Any] = [
            "timestamp": Int64(Date().timeIntervalSince1970 * 1000),
        ]
        Bridge.sendTypedMessage("ota_start_ack", body: eventBody)
    }

    static func sendOtaStatus(
        sessionId: String,
        totalSteps: Int,
        currentStep: Int,
        stepType: String,
        phase: String,
        stepPercent: Int,
        overallPercent: Int,
        status: String,
        errorMessage: String?,
        glassesTimeMs: Int64? = nil
    ) {
        var eventBody: [String: Any] = [
            "session_id": sessionId,
            "total_steps": totalSteps,
            "current_step": currentStep,
            "step_type": stepType,
            "phase": phase,
            "step_percent": stepPercent,
            "overall_percent": overallPercent,
            "status": status,
        ]
        if let error = errorMessage {
            eventBody["error_message"] = error
        }
        if let glassesTimeMs, glassesTimeMs > 0 {
            eventBody["glasses_time_ms"] = glassesTimeMs
        }
        Bridge.sendTypedMessage("ota_status", body: eventBody)
    }

    /// Arbitrary WS Comms (dont use these, make a dedicated function for your use case):
    static func sendWSText(_ msg: String) {
        let data = ["text": msg]
        Bridge.sendTypedMessage("ws_text", body: data)
    }

    static func sendWSBinary(_ data: Data) {
        let base64String = data.base64EncodedString()
        let body = ["base64": base64String]
        Bridge.sendTypedMessage("ws_bin", body: body)
    }

    /// don't call this function directly, instead
    /// make a function above that calls this function:
    static func sendTypedMessage(_ type: String, body: [String: Any]) {
        var body = body
        body["type"] = type
        if let tracePayload = tracePayloadForTypedMessage(type, body: body) {
            BleTraceLogger.logMap(
                direction: "phone_to_app",
                layer: "sdk_event_dispatch",
                type: type,
                payload: tracePayload
            )
        }
        // Send directly using type as event name - no JSON serialization
        dispatchEvent(type, body)
    }

    private static func tracePayloadForTypedMessage(_ type: String, body: [String: Any]) -> [String: Any]? {
        if type == "log" {
            return nil
        }
        if isAudioPayloadEvent(type) {
            return audioTracePayload(type, body: body)
        }
        return body
    }

    private static func isAudioPayloadEvent(_ type: String) -> Bool {
        type == "mic_pcm" || type == "mic_lc3"
    }

    private static func audioTracePayload(_ type: String, body: [String: Any]) -> [String: Any] {
        var payload: [String: Any] = [
            "type": type,
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
            "payloadOmitted": true,
            "payloadOmittedReason": "audio",
        ]

        switch type {
        case "mic_pcm":
            if let data = body["pcm"] as? Data {
                payload["audioBytes"] = data.count
            }
        case "mic_lc3":
            if let data = body["lc3"] as? Data {
                payload["audioBytes"] = data.count
            }
        default:
            break
        }

        for key in audioTraceMetadataKeys {
            if let value = body[key] {
                payload[key] = value
            }
        }

        return payload
    }
}
