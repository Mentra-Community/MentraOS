//
//  Bridge.swift
//  AOS
//
//  Created by Matthew Fosse on 3/4/25.
//

import Foundation

// Bridge for core communication between Expo modules and native iOS code
// Has commands for the core to use to send messages to JavaScript
class Bridge {
    // Event callback for sending events to JS
    static var eventCallback: ((String, [String: Any]) -> Void)?

    static func initialize(callback: @escaping (String, [String: Any]) -> Void) {
        eventCallback = callback
    }

    /// Thread-safe event dispatch - ensures callback is invoked on main thread
    /// to avoid React Native bridge threading issues that can cause EXC_BREAKPOINT
    private static func dispatchEvent(_ eventName: String, _ data: [String: Any]) {
        guard let callback = eventCallback else { return }
        if Thread.isMainThread {
            callback(eventName, data)
        } else {
            DispatchQueue.main.async {
                callback(eventName, data)
            }
        }
    }

    static func log(_ message: String) {
        let data = ["message": message]
        Bridge.sendTypedMessage("log", body: data)
    }

    static func sendEvent(withName: String, body: String) {
        let data: [String: Any] = ["body": body]
        dispatchEvent(withName, data)
    }

    static func sendHeadUp(_ isUp: Bool) {
        let data = ["up": isUp]
        Bridge.sendTypedMessage("head_up", body: data)
    }

    static func sendPairFailureEvent(_ error: String) {
        let data = ["error": error]
        Bridge.sendTypedMessage("pair_failure", body: data)
    }

    /// Send microphone data to React Native.
    /// React Native handles the decision of whether to send via UDP or WebSocket.
    /// This keeps the native layer simple and UDP logic centralized in React Native.
    static func sendMicData(_ data: Data) {
        let base64String = data.base64EncodedString()
        let body = ["base64": base64String]
        Bridge.sendTypedMessage("mic_data", body: body)
    }

    static func saveSetting(_ key: String, _ value: Any) {
        let body = ["key": key, "value": value]
        Bridge.sendTypedMessage("save_setting", body: body)
    }

    static func sendVadStatus(_ isSpeaking: Bool) {
        let vadMsg: [String: Any] = [
            "type": "VAD",
            "status": isSpeaking,
        ]

        let jsonData = try! JSONSerialization.data(withJSONObject: vadMsg)
        if let jsonString = String(data: jsonData, encoding: .utf8) {
            Bridge.sendWSText(jsonString)
        }
    }

    static func sendBatteryStatus(level: Int, charging: Bool) {
        let vadMsg: [String: Any] = [
            "type": "glasses_battery_update",
            "level": level,
            "charging": charging,
            "timestamp": Date().timeIntervalSince1970 * 1000,
            // TODO: time remaining
        ]

        let jsonData = try! JSONSerialization.data(withJSONObject: vadMsg)
        if let jsonString = String(data: jsonData, encoding: .utf8) {
            Bridge.sendWSText(jsonString)
        }
    }

    static func sendDiscoveredDevice(_ deviceModel: String, _ deviceName: String) {
        Task {
            await MainActor.run {
                let searchResults =
                    GlassesStore.shared.get("core", "searchResults") as? [[String: Any]] ?? []
                let newResult: [String: Any] = [
                    "deviceModel": deviceModel,
                    "deviceName": deviceName,
                ]
                let allResults = searchResults + [newResult]
                var seen = Set<String>()
                let uniqueResults = allResults.reversed().filter {
                    guard let name = $0["deviceName"] as? String else { return false }
                    return seen.insert(name).inserted
                }.reversed()
                GlassesStore.shared.set("core", "searchResults", Array(uniqueResults))
            }
        }
    }

    static func updateAsrConfig(languages: [[String: Any]]) {
        do {
            let configMsg: [String: Any] = [
                "type": "config",
                "streams": languages,
            ]

            let jsonData = try JSONSerialization.data(withJSONObject: configMsg)
            if let jsonString = String(data: jsonData, encoding: .utf8) {
                Bridge.sendWSText(jsonString)
            }
        } catch {
            Bridge.log("ServerComms: Error building config message: \(error)")
        }
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

    static func sendTouchEvent(deviceModel: String, gestureName: String, timestamp: Int64) {
        let body: [String: Any] = [
            "device_model": deviceModel,
            "gesture_name": gestureName,
            "timestamp": timestamp,
        ]
        Bridge.sendTypedMessage("touch_event", body: body)
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
            "switch_type": switchType,
            "switch_value": value,
            "timestamp": timestamp,
        ]
        Bridge.sendTypedMessage("switch_status", body: body)
    }

    static func sendRgbLedControlResponse(requestId: String, success: Bool, error: String?) {
        guard !requestId.isEmpty else { return }
        var body: [String: Any] = [
            "requestId": requestId,
            "success": success,
        ]
        if let error {
            body["error"] = error
        }
        Bridge.sendTypedMessage("rgb_led_control_response", body: body)
    }

    static func sendPhotoResponse(requestId: String, photoUrl: String) {
        do {
            let event: [String: Any] = [
                "type": "photo_response",
                "requestId": requestId,
                "photoUrl": photoUrl,
                "timestamp": Int(Date().timeIntervalSince1970 * 1000),
            ]

            let jsonData = try JSONSerialization.data(withJSONObject: event)
            if let jsonString = String(data: jsonData, encoding: .utf8) {
                Bridge.sendWSText(jsonString)
            }
        } catch {
            Bridge.log("ServerComms: Error building photo_response JSON: \(error)")
        }
    }

    static func sendVideoStreamResponse(appId: String, streamUrl: String) {
        do {
            let event: [String: Any] = [
                "type": "video_stream_response",
                "appId": appId,
                "streamUrl": streamUrl,
                "timestamp": Int(Date().timeIntervalSince1970 * 1000),
            ]

            let jsonData = try JSONSerialization.data(withJSONObject: event)
            if let jsonString = String(data: jsonData, encoding: .utf8) {
                Bridge.sendWSText(jsonString)
            }
        } catch {
            Bridge.log("ServerComms: Error building video_stream_response JSON: \(error)")
        }
    }

    static func sendHeadPosition(isUp: Bool) {
        do {
            let event: [String: Any] = [
                "type": "head_position",
                "position": isUp ? "up" : "down",
                "timestamp": Int(Date().timeIntervalSince1970 * 1000),
            ]

            let jsonData = try JSONSerialization.data(withJSONObject: event)
            if let jsonString = String(data: jsonData, encoding: .utf8) {
                Bridge.sendWSText(jsonString)
            }
        } catch {
            Bridge.log("ServerComms: Error sending head position: \(error)")
        }
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

    // core bridge funcs:

    static func sendStatus(_ statusObj: [String: Any]) {
        let body = ["core_status": statusObj]
        Bridge.sendTypedMessage("core_status_update", body: body)
    }

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

    static func sendWifiStatusChange(connected: Bool, ssid: String?, localIp: String?) {
        let event: [String: Any] = [
            "connected": connected,
            "ssid": ssid,
            "local_ip": localIp,
        ]
        Bridge.sendTypedMessage("wifi_status_change", body: event)
    }

    static func updateWifiScanResults(_ networks: [[String: Any]]) {
        Task {
            await MainActor.run {
                var storedNetworks: [[String: Any]] =
                    GlassesStore.shared.get("core", "wifiScanResults") as? [[String: Any]] ?? []
                // add the networks to the storedNetworks array, removing duplicates by ssid
                for network in networks {
                    if !storedNetworks.contains(where: {
                        $0["ssid"] as? String == network["ssid"] as? String
                    }) {
                        storedNetworks.append(network)
                    }
                }
                GlassesStore.shared.apply("core", "wifiScanResults", storedNetworks)
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

    /// Send OTA update available notification - glasses have detected an available update (background mode)
    static func sendOtaUpdateAvailable(
        versionCode: Int64,
        versionName: String,
        updates: [String],
        totalSize: Int64
    ) {
        let eventBody: [String: Any] = [
            "version_code": versionCode,
            "version_name": versionName,
            "updates": updates,
            "total_size": totalSize,
        ]
        Bridge.sendTypedMessage("ota_update_available", body: eventBody)
    }

    /// Send OTA progress update - glasses are downloading/installing an update
    static func sendOtaProgress(
        stage: String,
        status: String,
        progress: Int,
        bytesDownloaded: Int64,
        totalBytes: Int64,
        currentUpdate: String,
        errorMessage: String?
    ) {
        var eventBody: [String: Any] = [
            "stage": stage,
            "status": status,
            "progress": progress,
            "bytes_downloaded": bytesDownloaded,
            "total_bytes": totalBytes,
            "current_update": currentUpdate,
        ]
        if let error = errorMessage {
            eventBody["error_message"] = error
        }
        Bridge.sendTypedMessage("ota_progress", body: eventBody)
    }

    // Arbitrary WS Comms (dont use these, make a dedicated function for your use case):
    static func sendWSText(_ msg: String) {
        let data = ["text": msg]
        Bridge.sendTypedMessage("ws_text", body: data)
    }

    static func sendWSBinary(_ data: Data) {
        let base64String = data.base64EncodedString()
        let body = ["base64": base64String]
        Bridge.sendTypedMessage("ws_bin", body: body)
    }

    // don't call this function directly, instead
    // make a function above that calls this function:
    static func sendTypedMessage(_ type: String, body: [String: Any]) {
        var body = body
        body["type"] = type
        // Send directly using type as event name - no JSON serialization
        dispatchEvent(type, body)
    }
}
