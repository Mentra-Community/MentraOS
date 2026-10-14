@testable import MentraBluetoothSDK
import XCTest

@MainActor
private final class SessionReadinessTransport: MentraLive {
    var commands: [[String: Any]] = []

    override func sendJson(_ jsonOriginal: [String: Any], wakeUp: Bool, requireAck: Bool) {
        commands.append(jsonOriginal)
    }
}

@MainActor
final class MentraLiveSessionReadinessTests: XCTestCase {
    func testChangedSessionPublishesPendingReadinessBeforeItsBuildAndRecoversAtGlassesReady() throws {
        let store = DeviceStore.shared.store
        let saved = ["bluetooth", "glasses"].map { ($0, store.getCategory($0)) }
        let previous = DeviceManager.shared.sgc
        let transport = SessionReadinessTransport()
        let sdk = MentraBluetoothSDK()
        DeviceManager.shared.sgc = transport
        var observations: [(key: String, ready: Bool, connected: Bool)] = []
        let listener = store.addListener { category, changed in
            guard category == "glasses" else { return }
            for key in changed.keys where key == "fullyBooted" || key == "buildNumber" {
                observations.append((key, sdk.glassesStatus.fullyBooted, sdk.glassesStatus.connected))
            }
        }
        var sessionEvents: [Bool] = []
        let sink = Bridge.addEventSink { event, body in
            if event == "glasses_session_changed" {
                sessionEvents.append(sdk.glassesStatus.fullyBooted)
            }
        }
        defer {
            store.removeListener(listener)
            Bridge.removeEventSink(sink)
            sdk.invalidate()
            transport.cleanup()
            DeviceManager.shared.sgc = previous
            for (category, values) in saved {
                for key in store.getCategory(category).keys where values[key] == nil {
                    store.remove(category, key)
                }
                for (key, value) in values { store.set(category, key, value) }
            }
        }

        func receive(_ value: [String: Any]) throws {
            try transport.processReceivedData(JSONSerialization.data(withJSONObject: value))
        }
        try receive(["type": "glasses_ready", "sid": "original"])
        observations.removeAll()
        transport.commands.removeAll()

        // The physical BLE link remains live across APK replacement. Its first
        // version chunk can prove the target build before remote wire readiness.
        try receive(["type": "version_info_1", "sid": "replacement", "build_number": "302010070"])
        XCTAssertEqual(observations.map(\.key), ["fullyBooted", "buildNumber"])
        XCTAssertTrue(observations.allSatisfy { !$0.ready && $0.connected })
        XCTAssertEqual(sessionEvents, [false])
        XCTAssertEqual(transport.commands.compactMap { $0["type"] as? String }, ["phone_ready"])

        // Another chunk from the same pending process must not restart readiness.
        try receive(["type": "version_info_3", "sid": "replacement"])
        XCTAssertEqual(sessionEvents, [false])
        XCTAssertFalse(sdk.glassesStatus.fullyBooted)

        try receive(["type": "glasses_ready", "sid": "replacement"])
        XCTAssertTrue(sdk.glassesStatus.connected)
        XCTAssertTrue(sdk.glassesStatus.fullyBooted)
        XCTAssertEqual(observations.last?.key, "fullyBooted")
        XCTAssertEqual(observations.last?.ready, true)
        XCTAssertEqual(transport.commands.filter { $0["type"] as? String == "request_version" }.count, 1)

        observations.removeAll()
        try receive(["type": "version_info_1", "sid": "replacement", "build_number": "302010070"])
        XCTAssertTrue(sdk.glassesStatus.fullyBooted)
        XCTAssertFalse(observations.contains { $0.key == "fullyBooted" })
        XCTAssertEqual(sessionEvents, [false])

        // A physical teardown before the next logical restart becomes ready must
        // still run disconnect cleanup, even though readiness is already false.
        try receive(["type": "version_info_1", "sid": "third", "build_number": "303000267"])
        store.set("glasses", "headUp", true)
        store.set("glasses", "voiceActivityDetectionEnabled", !BluetoothSdkDefaults.voiceActivityDetectionEnabled)
        XCTAssertFalse(sdk.glassesStatus.fullyBooted)
        XCTAssertTrue(sdk.glassesStatus.connected)
        transport.cleanup()
        XCTAssertFalse(sdk.glassesStatus.connected)
        XCTAssertEqual(store.get("glasses", "headUp") as? Bool, false)
        XCTAssertEqual(store.get("glasses", "voiceActivityDetectionEnabled") as? Bool,
                       BluetoothSdkDefaults.voiceActivityDetectionEnabled)
    }

    func testPairingYieldDuringPendingReadinessCleansUpAndKeepsTheOwnerForTheWholeWindow() async throws {
        let store = DeviceStore.shared.store
        let saved = ["bluetooth", "glasses"].map { ($0, store.getCategory($0)) }
        let previous = DeviceManager.shared.sgc
        let transport = SessionReadinessTransport()
        let sdk = MentraBluetoothSDK()
        DeviceManager.shared.sgc = transport
        defer {
            sdk.invalidate()
            transport.cleanup()
            DeviceManager.shared.sgc = previous
            for (category, values) in saved {
                for key in store.getCategory(category).keys where values[key] == nil {
                    store.remove(category, key)
                }
                for (key, value) in values { store.set(category, key, value) }
            }
        }

        func receive(_ value: [String: Any]) throws {
            try transport.processReceivedData(JSONSerialization.data(withJSONObject: value))
        }
        try receive(["type": "glasses_ready", "sid": "original"])
        try receive(["type": "version_info_1", "sid": "replacement", "build_number": "302010070"])
        XCTAssertTrue(sdk.glassesStatus.connected)
        XCTAssertFalse(sdk.glassesStatus.fullyBooted)
        store.set("glasses", "headUp", true)
        store.set("glasses", "voiceActivityDetectionEnabled", !BluetoothSdkDefaults.voiceActivityDetectionEnabled)

        var enteringBodies: [[String: Any]] = []
        let enteringSink = Bridge.addEventSink { event, body in
            if event == "entering_pairing_mode" { enteringBodies.append(body) }
        }
        defer { Bridge.removeEventSink(enteringSink) }

        // Ownership transfer: the glasses kept this phone as owner, so it yields.
        try receive(["type": "entering_pairing_mode", "window_ms": 5000, "owner_retained": true])
        XCTAssertTrue(transport.isPairingYieldActive())
        XCTAssertFalse(transport.isManagerKilled)
        XCTAssertNotEqual(store.get("bluetooth", "mentra_live_owner_lost") as? Bool, true)
        XCTAssertEqual(enteringBodies.count, 1)
        XCTAssertEqual(enteringBodies.first?["owner_retained"] as? Bool, true)
        XCTAssertFalse(sdk.glassesStatus.connected)
        XCTAssertFalse(sdk.glassesStatus.fullyBooted)
        XCTAssertEqual(store.get("glasses", "headUp") as? Bool, false)
        XCTAssertEqual(store.get("glasses", "voiceActivityDetectionEnabled") as? Bool,
                       BluetoothSdkDefaults.voiceActivityDetectionEnabled)

        // Readiness queued on the relinquished GATT must not close the yield.
        try receive(["type": "glasses_ready", "sid": "replacement"])
        XCTAssertTrue(transport.isPairingYieldActive())
        XCTAssertFalse(sdk.glassesStatus.fullyBooted)

        // The yield covers the whole 300 s window, not the 5 s idle value in the message.
        try await Task.sleep(nanoseconds: 5_500_000_000)
        XCTAssertTrue(transport.isPairingYieldActive())
    }

    func testEnteringPairingModeWithoutOwnerRetainedStillStandsDown() async throws {
        let store = DeviceStore.shared.store
        let saved = ["bluetooth", "glasses"].map { ($0, store.getCategory($0)) }
        let previous = DeviceManager.shared.sgc
        let transport = SessionReadinessTransport()
        let sdk = MentraBluetoothSDK()
        DeviceManager.shared.sgc = transport
        var enteringEvents = 0
        let sink = Bridge.addEventSink { event, _ in
            if event == "entering_pairing_mode" { enteringEvents += 1 }
        }
        defer {
            Bridge.removeEventSink(sink)
            sdk.invalidate()
            transport.cleanup()
            DeviceManager.shared.sgc = previous
            for (category, values) in saved {
                for key in store.getCategory(category).keys where values[key] == nil {
                    store.remove(category, key)
                }
                for (key, value) in values { store.set(category, key, value) }
            }
        }

        try transport.processReceivedData(JSONSerialization.data(withJSONObject: [
            "type": "entering_pairing_mode", "window_ms": 5000,
        ]))
        // The owner-lost flag is applied on a main-actor task.
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertFalse(transport.isPairingYieldActive())
        // The first pairing mode rejects this phone without killing the manager, so a
        // later pairing mode can lift the rejection.
        XCTAssertFalse(transport.isManagerKilled)
        XCTAssertTrue(transport.isPreviousOwnerRejectionActive())
        XCTAssertEqual(store.get("bluetooth", "mentra_live_owner_lost") as? Bool, true)
        XCTAssertEqual(enteringEvents, 0)

        try transport.processReceivedData(JSONSerialization.data(withJSONObject: [
            "type": "entering_pairing_mode", "window_ms": 5000,
        ]))
        try await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertFalse(transport.isPreviousOwnerRejectionActive())
        XCTAssertNotEqual(store.get("bluetooth", "mentra_live_owner_lost") as? Bool, true)
    }

    func testInitialVersionChunkDoesNotStartAnExtraReadinessExchange() throws {
        let store = DeviceStore.shared.store
        let saved = store.getCategory("glasses")
        let transport = SessionReadinessTransport()
        defer {
            transport.cleanup()
            for key in store.getCategory("glasses").keys where saved[key] == nil { store.remove("glasses", key) }
            for (key, value) in saved { store.set("glasses", key, value) }
        }
        store.set("glasses", "fullyBooted", false)
        try transport.processReceivedData(JSONSerialization.data(withJSONObject: [
            "type": "version_info_1", "sid": "initial", "build_number": "303000267",
        ]))
        XCTAssertTrue(transport.commands.isEmpty)
        XCTAssertEqual(store.get("glasses", "buildNumber") as? String, "303000267")
        XCTAssertEqual(store.get("glasses", "fullyBooted") as? Bool, false)
    }
}
