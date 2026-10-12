import Foundation

/// The subset of glasses status the analytics decision logic needs.
struct AnalyticsGlassesSnapshot {
    var connected: Bool
    var fullyBooted: Bool
    var model: String
    var serialNumber: String
    var firmwareVersion = ""
    var besFirmwareVersion = ""
    var mtkFirmwareVersion = ""
    var androidVersion = ""
    var appVersion = ""
    var buildNumber = ""
    /// -1 while the glasses have not reported a level.
    var batteryLevel = -1
    var charging = false
}

struct AnalyticsEvent {
    let name: String
    let properties: [String: Any]
}

/// Pure decision logic for the SDK usage events. It owns no threads and no I/O so
/// the connection/identification/heartbeat rules can be unit-tested directly.
///
/// Rules:
/// - `bluetooth_sdk_glasses_connected` once per connection. If the model is not
///   known yet at connect time the event waits for it, and is emitted without a
///   model only if the connection ends first.
/// - `bluetooth_sdk_glasses_identified` once per connection per serial, plus a
///   `glasses_heartbeat` re-emission on the first status update of each new
///   reporting day while still connected, so a connection spanning a week boundary
///   is visible in both weeks. Reporting days follow `America/Los_Angeles`, the
///   calendar the WAU weeks are cut on; a UTC day would miss the Sunday-evening to
///   Monday-morning Pacific boundary, which is one UTC day.
/// - `bluetooth_sdk_glasses_disconnected` when a counted connection ends, with its
///   length, why it ended, and the battery levels seen during it. The reason is
///   supplied by the caller: an SDK disconnect/forget/cancel call, the phone's
///   Bluetooth turning off, or otherwise a lost link.
struct BluetoothSdkAnalyticsTracker {
    static let disconnectUser = "user_disconnect"
    static let disconnectForget = "forget"
    static let disconnectCancel = "cancel"
    static let disconnectBluetoothOff = "bluetooth_off"
    static let disconnectLinkLost = "link_lost"
    static let disconnectUnknown = "unknown"
    static let millisPerDay: Int64 = 86_400_000
    static let reportingZone = TimeZone(identifier: "America/Los_Angeles")!

    /// Calendar day in the reporting zone, as days since the epoch of that zone's midnight.
    static func reportingDay(epochMillis: Int64) -> Int64 {
        let offsetMillis = Int64(reportingZone.secondsFromGMT(for: Date(timeIntervalSince1970: Double(epochMillis) / 1000))) * 1000
        let local = epochMillis + offsetMillis
        let day = local / millisPerDay
        return local < 0 && local % millisPerDay != 0 ? day - 1 : day
    }

    static func reportingDay(date: Date = Date()) -> Int64 {
        reportingDay(epochMillis: Int64((date.timeIntervalSince1970 * 1000).rounded(.down)))
    }

    private let simulatedModel: String
    private var lastConnected = false
    private var connectedPendingModel = false
    private var identifiedSerial: String?
    private var identifiedReportingDay: Int64?
    private var connectedAtMs: Int64?
    private var batteryAtConnect = -1
    private var lastBattery = -1
    private var lastCharging: Bool?
    private var lastModel = ""

    init(simulatedModel: String) {
        self.simulatedModel = simulatedModel
    }

    mutating func initialize(_ snapshot: AnalyticsGlassesSnapshot, reportingDay: Int64) {
        lastConnected = snapshot.connected
        connectedPendingModel = false
        // Only treat identification as already captured when a valid serial is present
        // at init. If the glasses are connected but the serial has not arrived yet
        // (Mentra Live fills it via version_info after connect), leave this nil so the
        // identify event still fires once the serial arrives.
        identifiedSerial = snapshot.connected ? snapshot.serialNumber.validManufacturingSerial : nil
        identifiedReportingDay = identifiedSerial == nil ? nil : reportingDay
    }

    mutating func observe(
        _ snapshot: AnalyticsGlassesSnapshot,
        reportingDay: Int64,
        nowMs: Int64 = 0,
        disconnectReason: () -> String = { BluetoothSdkAnalyticsTracker.disconnectUnknown }
    ) -> [AnalyticsEvent] {
        var events: [AnalyticsEvent] = []
        let wasConnected = lastConnected
        lastConnected = snapshot.connected

        guard snapshot.connected else {
            if connectedPendingModel {
                connectedPendingModel = false
                events.append(connectedEvent(snapshot, modelUnresolved: true))
            }
            if let connectedAtMs {
                events.append(disconnectedEvent(durationMs: nowMs - connectedAtMs, reason: disconnectReason()))
            }
            connectedAtMs = nil
            identifiedSerial = nil
            identifiedReportingDay = nil
            return events
        }

        if !snapshot.model.isBlank { lastModel = snapshot.model }
        if snapshot.batteryLevel >= 0 {
            if batteryAtConnect < 0 { batteryAtConnect = snapshot.batteryLevel }
            lastBattery = snapshot.batteryLevel
            lastCharging = snapshot.charging
        }

        if !wasConnected {
            identifiedSerial = nil
            identifiedReportingDay = nil
            connectedAtMs = nowMs
            lastModel = snapshot.model
            batteryAtConnect = snapshot.batteryLevel
            lastBattery = snapshot.batteryLevel
            lastCharging = snapshot.batteryLevel >= 0 ? snapshot.charging : nil
            if snapshot.model.isBlank {
                connectedPendingModel = true
            } else {
                events.append(connectedEvent(snapshot, modelUnresolved: false))
            }
        } else if connectedPendingModel, !snapshot.model.isBlank {
            connectedPendingModel = false
            events.append(connectedEvent(snapshot, modelUnresolved: false))
        }

        guard let serial = snapshot.serialNumber.validManufacturingSerial else { return events }
        if identifiedSerial != serial {
            identifiedSerial = serial
            identifiedReportingDay = reportingDay
            events.append(identifiedEvent(snapshot, serial: serial, kind: "glasses_identified"))
        } else if identifiedReportingDay != reportingDay {
            identifiedReportingDay = reportingDay
            events.append(identifiedEvent(snapshot, serial: serial, kind: "glasses_heartbeat"))
        }
        return events
    }

    private func connectedEvent(_ snapshot: AnalyticsGlassesSnapshot, modelUnresolved: Bool) -> AnalyticsEvent {
        var properties: [String: Any] = [
            "event_kind": "glasses_connected",
            "fully_booted": snapshot.fullyBooted,
            "glasses_is_simulated": snapshot.model == simulatedModel,
        ]
        if !snapshot.model.isBlank { properties["glasses_model"] = snapshot.model }
        if modelUnresolved { properties["glasses_model_unresolved"] = true }
        return AnalyticsEvent(name: "bluetooth_sdk_glasses_connected", properties: properties)
    }

    private func disconnectedEvent(durationMs: Int64, reason: String) -> AnalyticsEvent {
        var properties: [String: Any] = [
            "event_kind": "glasses_disconnected",
            "session_duration_ms": max(durationMs, 0),
            "disconnect_reason": reason,
            "glasses_is_simulated": lastModel == simulatedModel,
        ]
        if !lastModel.isBlank { properties["glasses_model"] = lastModel }
        if batteryAtConnect >= 0 { properties["battery_level_at_connect"] = batteryAtConnect }
        if lastBattery >= 0 { properties["battery_level_at_disconnect"] = lastBattery }
        if let lastCharging { properties["charging"] = lastCharging }
        return AnalyticsEvent(name: "bluetooth_sdk_glasses_disconnected", properties: properties)
    }

    private func identifiedEvent(_ snapshot: AnalyticsGlassesSnapshot, serial: String, kind: String) -> AnalyticsEvent {
        var properties: [String: Any] = [
            "event_kind": kind,
            "fully_booted": snapshot.fullyBooted,
            "glasses_device_id": serial,
            "glasses_device_id_type": "manufacturing_serial",
            "glasses_is_simulated": snapshot.model == simulatedModel,
        ]
        if !snapshot.model.isBlank { properties["glasses_model"] = snapshot.model }
        let software: [(String, String)] = [
            ("glasses_firmware_version", snapshot.firmwareVersion),
            ("glasses_bes_firmware_version", snapshot.besFirmwareVersion),
            ("glasses_mtk_firmware_version", snapshot.mtkFirmwareVersion),
            ("glasses_android_version", snapshot.androidVersion),
            ("glasses_app_version", snapshot.appVersion),
            ("glasses_build_number", snapshot.buildNumber),
        ]
        for (key, value) in software where !value.isBlank {
            properties[key] = value
        }
        return AnalyticsEvent(name: "bluetooth_sdk_glasses_identified", properties: properties)
    }
}

extension String {
    var isBlank: Bool {
        trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var validManufacturingSerial: String? {
        let normalized = trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty, normalized.contains(where: { $0 != "0" }) else { return nil }
        return normalized
    }
}
