@testable import MentraBluetoothSDK
import XCTest

@MainActor
private final class SessionReadinessTransport: MentraLive {
    var commands: [[String: Any]] = []

    override func sendJson(_ jsonOriginal: [String: Any], wakeUp: Bool, requireAck: Bool) {
        commands.append(jsonOriginal)
    }

    func phoneReadyIds() -> [String] {
        commands.filter { $0["type"] as? String == "phone_ready" }.compactMap { $0["readyId"] as? String }
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

    func testPairingYieldDuringPendingReadinessCleansUpAndReclaimsAfterItsWindow() async throws {
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

        try receive(["type": "entering_pairing_mode", "window_ms": 5000])
        XCTAssertTrue(transport.isPairingYieldActive())
        XCTAssertFalse(sdk.glassesStatus.connected)
        XCTAssertFalse(sdk.glassesStatus.fullyBooted)
        XCTAssertEqual(store.get("glasses", "headUp") as? Bool, false)
        XCTAssertEqual(store.get("glasses", "voiceActivityDetectionEnabled") as? Bool,
                       BluetoothSdkDefaults.voiceActivityDetectionEnabled)

        // Readiness queued on the relinquished GATT must not close the yield.
        try receive(["type": "glasses_ready", "sid": "replacement"])
        XCTAssertTrue(transport.isPairingYieldActive())
        XCTAssertFalse(sdk.glassesStatus.fullyBooted)

        // Let the existing minimum yield expire, then accept a fresh readiness.
        try await Task.sleep(nanoseconds: 5_100_000_000)
        XCTAssertFalse(transport.isPairingYieldActive())
        try receive(["type": "glasses_ready", "sid": "reclaimed"])
        XCTAssertTrue(sdk.glassesStatus.connected)
        XCTAssertTrue(sdk.glassesStatus.fullyBooted)
    }

    func testBufferedPhoneReadyCopiesAreOneExchangeWithOneInit() throws {
        try withReadinessTransport { transport, receive, versionRequests in
            // Two SOC-ready heartbeats while the glasses boot: one exchange, sent twice.
            try receive(["C": "sr_hrt", "B": ["ready": 1]])
            try receive(["C": "sr_hrt", "B": ["ready": 1]])
            let readyIds = transport.phoneReadyIds()
            XCTAssertEqual(readyIds.count, 2)
            XCTAssertEqual(Set(readyIds).count, 1)
            let readyId = try XCTUnwrap(readyIds.first)

            // The glasses answer every buffered copy; only the first followed a reset.
            for _ in 0 ..< 7 {
                try receive(["type": "glasses_ready", "sid": "booted", "readyId": readyId])
            }
            XCTAssertEqual(versionRequests(), 1)
            XCTAssertEqual(DeviceStore.shared.store.get("glasses", "fullyBooted") as? Bool, true)
        }
    }

    func testRestartedGlassesProcessStartsANewExchangeAndIgnoresStaleAnswers() throws {
        try withReadinessTransport { transport, receive, versionRequests in
            try receive(["C": "sr_hrt", "B": ["ready": 1]])
            let first = try XCTUnwrap(transport.phoneReadyIds().last)
            try receive(["type": "glasses_ready", "sid": "booted", "readyId": first])

            // asg restarted under the live link: a new exchange, and the old one's answers no
            // longer count even though the new process will reset for its own.
            try receive(["type": "version_info_1", "sid": "restarted", "build_number": "302010073"])
            let second = try XCTUnwrap(transport.phoneReadyIds().last)
            XCTAssertNotEqual(second, first)
            try receive(["type": "glasses_ready", "sid": "booted", "readyId": first])
            XCTAssertEqual(versionRequests(), 1)

            try receive(["type": "glasses_ready", "sid": "restarted", "readyId": second])
            XCTAssertEqual(versionRequests(), 2)
        }
    }

    func testAnswerFromAnotherGlassesProcessIsHandledWithNoExchangePending() throws {
        try withReadinessTransport { transport, receive, versionRequests in
            try receive(["C": "sr_hrt", "B": ["ready": 1]])
            let readyId = try XCTUnwrap(transport.phoneReadyIds().last)
            try receive(["type": "glasses_ready", "sid": "booted", "readyId": readyId])

            // A different process reset its transport for this copy, so it is not a repeat.
            try receive(["type": "glasses_ready", "sid": "restarted", "readyId": readyId])
            XCTAssertEqual(versionRequests(), 2)
        }
    }

    func testGlassesWithoutReadyIdKeepInitializingOnEveryAnswer() throws {
        try withReadinessTransport { _, receive, versionRequests in
            try receive(["type": "glasses_ready", "sid": "legacy"])
            try receive(["type": "glasses_ready", "sid": "legacy"])
            XCTAssertEqual(versionRequests(), 2)
        }
    }

    /// Runs `body` on a fresh transport whose glasses have not reported readiness yet.
    private func withReadinessTransport(
        _ body: (
            SessionReadinessTransport,
            ([String: Any]) throws -> Void,
            () -> Int
        ) throws -> Void
    ) throws {
        let store = DeviceStore.shared.store
        let saved = ["bluetooth", "glasses"].map { ($0, store.getCategory($0)) }
        let previous = DeviceManager.shared.sgc
        let transport = SessionReadinessTransport()
        DeviceManager.shared.sgc = transport
        defer {
            transport.cleanup()
            DeviceManager.shared.sgc = previous
            for (category, values) in saved {
                for key in store.getCategory(category).keys where values[key] == nil {
                    store.remove(category, key)
                }
                for (key, value) in values {
                    store.set(category, key, value)
                }
            }
        }
        store.set("glasses", "fullyBooted", false)

        func receive(_ value: [String: Any]) throws {
            try transport.processReceivedData(JSONSerialization.data(withJSONObject: value))
        }
        func versionRequests() -> Int {
            transport.commands.filter { $0["type"] as? String == "request_version" }.count
        }
        try body(transport, receive, versionRequests)
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
