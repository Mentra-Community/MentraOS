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
///   `glasses_heartbeat` re-emission on the first status update of each new UTC day
///   while still connected, so a connection spanning a week boundary is visible in
///   both weeks.
struct BluetoothSdkAnalyticsTracker {
    static let millisPerUtcDay: Int64 = 86_400_000

    static func utcDay(epochMillis: Int64) -> Int64 {
        let day = epochMillis / millisPerUtcDay
        return epochMillis < 0 && epochMillis % millisPerUtcDay != 0 ? day - 1 : day
    }

    static func utcDay(date: Date = Date()) -> Int64 {
        utcDay(epochMillis: Int64((date.timeIntervalSince1970 * 1000).rounded(.down)))
    }

    private let simulatedModel: String
    private var lastConnected = false
    private var connectedPendingModel = false
    private var identifiedSerial: String?
    private var identifiedUtcDay: Int64?

    init(simulatedModel: String) {
        self.simulatedModel = simulatedModel
    }

    mutating func initialize(_ snapshot: AnalyticsGlassesSnapshot, utcDay: Int64) {
        lastConnected = snapshot.connected
        connectedPendingModel = false
        // Only treat identification as already captured when a valid serial is present
        // at init. If the glasses are connected but the serial has not arrived yet
        // (Mentra Live fills it via version_info after connect), leave this nil so the
        // identify event still fires once the serial arrives.
        identifiedSerial = snapshot.connected ? snapshot.serialNumber.validManufacturingSerial : nil
        identifiedUtcDay = identifiedSerial == nil ? nil : utcDay
    }

    mutating func observe(_ snapshot: AnalyticsGlassesSnapshot, utcDay: Int64) -> [AnalyticsEvent] {
        var events: [AnalyticsEvent] = []
        let wasConnected = lastConnected
        lastConnected = snapshot.connected

        guard snapshot.connected else {
            if connectedPendingModel {
                connectedPendingModel = false
                events.append(connectedEvent(snapshot, modelUnresolved: true))
            }
            identifiedSerial = nil
            identifiedUtcDay = nil
            return events
        }

        if !wasConnected {
            identifiedSerial = nil
            identifiedUtcDay = nil
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
            identifiedUtcDay = utcDay
            events.append(identifiedEvent(snapshot, serial: serial, kind: "glasses_identified"))
        } else if identifiedUtcDay != utcDay {
            identifiedUtcDay = utcDay
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
