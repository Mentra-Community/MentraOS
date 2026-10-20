import CoreBluetooth
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

    /// The pairing state is process-wide and persisted; every test starts and ends clean.
    private func resetPairingState() {
        UserDefaults.standard.removeObject(forKey: MentraLivePairingStateStore.defaultsKey)
        MentraLivePairingStateStore.shared.resetForTest()
    }

    private func withPairingTransport(
        _ body: (SessionReadinessTransport, MentraBluetoothSDK, ObservableStore) throws -> Void
    ) rethrows {
        let store = DeviceStore.shared.store
        let saved = ["bluetooth", "glasses"].map { ($0, store.getCategory($0)) }
        let previous = DeviceManager.shared.sgc
        resetPairingState()
        // The fixture models a live link. Pin phone Bluetooth on so the SDK does not tear the
        // transport down when the host has no usable radio (CI runners report it unsupported).
        BluetoothAvailability.shared.stateOverride = .poweredOn
        let transport = SessionReadinessTransport()
        let sdk = MentraBluetoothSDK()
        DeviceManager.shared.sgc = transport
        defer {
            sdk.invalidate()
            BluetoothAvailability.shared.stateOverride = nil
            transport.cleanup()
            DeviceManager.shared.sgc = previous
            resetPairingState()
            for (category, values) in saved {
                for key in store.getCategory(category).keys where values[key] == nil {
                    store.remove(category, key)
                }
                for (key, value) in values { store.set(category, key, value) }
            }
        }
        try body(transport, sdk, store)
    }

    private func receive(_ transport: MentraLive, _ value: [String: Any]) throws {
        try transport.processReceivedData(JSONSerialization.data(withJSONObject: value))
    }

    func testPairingPauseDuringPendingReadinessCleansUpAndLastsTheWindowPlusMargin() throws {
        try withPairingTransport { transport, sdk, store in
            try receive(transport, ["type": "glasses_ready", "sid": "original"])
            try receive(transport, ["type": "version_info_1", "sid": "replacement", "build_number": "302010070"])
            XCTAssertTrue(sdk.glassesStatus.connected)
            XCTAssertFalse(sdk.glassesStatus.fullyBooted)
            store.set("glasses", "headUp", true)

            var enteringBodies: [[String: Any]] = []
            var stateEvents: [[String: Any]] = []
            let sink = Bridge.addEventSink { event, body in
                if event == "entering_pairing_mode" { enteringBodies.append(body) }
                if event == "pairing_state_changed", let state = body["state"] as? [String: Any] {
                    stateEvents.append(state)
                }
            }
            defer { Bridge.removeEventSink(sink) }

            let before = MentraLivePairingStateStore.nowMs()
            try receive(transport, [
                "type": "entering_pairing_mode", "window_ms": 5000, "window_id": 7,
                "owner_retained": true, "protocol_version": 4,
            ])
            let after = MentraLivePairingStateStore.nowMs()
            let pairingStore = MentraLivePairingStateStore.shared
            XCTAssertTrue(pairingStore.isPaused)
            XCTAssertFalse(transport.isManagerKilled)
            guard case let .pairingMode(windowId, endsAtMs) = pairingStore.state else {
                return XCTFail("expected pairing_mode, got \(pairingStore.describe())")
            }
            XCTAssertEqual(windowId, 7)
            // window_ms + 30 s, with no 300 s floor.
            XCTAssertGreaterThanOrEqual(endsAtMs, before + 35_000)
            XCTAssertLessThanOrEqual(endsAtMs, after + 35_000)

            XCTAssertEqual(enteringBodies.count, 1)
            XCTAssertEqual(enteringBodies.first?["window_id"] as? Int, 7)
            XCTAssertEqual(enteringBodies.first?["owner_retained"] as? Bool, true)
            XCTAssertEqual(stateEvents.last?["state"] as? String, "pairing_mode")
            XCTAssertEqual(stateEvents.last?["windowId"] as? Int, 7)
            let published = store.get("glasses", "pairingState") as? [String: Any]
            XCTAssertEqual(published?["state"] as? String, "pairing_mode")
            XCTAssertEqual(sdk.glassesStatus.pairingState?["windowId"] as? Int, 7)
            XCTAssertFalse(sdk.glassesStatus.connected)
            XCTAssertEqual(store.get("glasses", "headUp") as? Bool, false)

            // Readiness queued on the relinquished GATT must not end the pause.
            try receive(transport, ["type": "glasses_ready", "sid": "replacement"])
            XCTAssertTrue(pairingStore.isPaused)
            XCTAssertFalse(sdk.glassesStatus.fullyBooted)

            // The pause is persisted with its window id.
            let record = UserDefaults.standard.dictionary(forKey: MentraLivePairingStateStore.defaultsKey)
            XCTAssertEqual(record?[MentraLivePairingStateMachine.keyWindowId] as? Int, 7)
            XCTAssertEqual(record?[MentraLivePairingStateMachine.keyState] as? String, "pairing_mode")

            // pairing_mode_ended for another window is ignored; the matching one resumes early.
            var endedBodies: [[String: Any]] = []
            let endedSink = Bridge.addEventSink { event, body in
                if event == "pairing_mode_ended" { endedBodies.append(body) }
            }
            defer { Bridge.removeEventSink(endedSink) }
            try receive(transport, ["type": "pairing_mode_ended", "reason": "timeout", "window_id": 8])
            XCTAssertTrue(pairingStore.isPaused)
            try receive(transport, ["type": "pairing_mode_ended", "reason": "timeout", "window_id": 7])
            XCTAssertEqual(pairingStore.state, .normal)
            XCTAssertEqual(endedBodies.count, 2)
            XCTAssertEqual(endedBodies.last?["reason"] as? String, "timeout")
            XCTAssertEqual(endedBodies.last?["window_id"] as? Int, 7)
            XCTAssertEqual(stateEvents.last?["state"] as? String, "normal")
        }
    }

    func testFlagOffFirmwareEnteringPairingModeIsAPersistentRejection() throws {
        try withPairingTransport { transport, _, store in
            var enteringEvents = 0
            let sink = Bridge.addEventSink { event, _ in
                if event == "entering_pairing_mode" { enteringEvents += 1 }
            }
            defer { Bridge.removeEventSink(sink) }

            try receive(transport, ["type": "entering_pairing_mode", "window_ms": 5000])
            let pairingStore = MentraLivePairingStateStore.shared
            XCTAssertTrue(pairingStore.isRejected)
            // The manager stays alive; the pairing state gates every automatic connect.
            XCTAssertFalse(transport.isManagerKilled)
            XCTAssertEqual(enteringEvents, 1)
            XCTAssertEqual((store.get("glasses", "pairingState") as? [String: Any])?["state"] as? String, "pairing_rejected")
            // Native code never writes the retired settings flag.
            XCTAssertNotEqual(store.get("bluetooth", "mentra_live_owner_lost") as? Bool, true)

            // A later pairing mode does not lift it, and the settings replay cannot either.
            try receive(transport, ["type": "entering_pairing_mode", "window_ms": 5000])
            store.set("bluetooth", "mentra_live_owner_lost", false)
            XCTAssertTrue(pairingStore.isRejected)

            // A restart keeps it.
            pairingStore.resetForTest()
            pairingStore.ensureRestored(savedDeviceId: "")
            XCTAssertTrue(pairingStore.isRejected)

            // A successful automatic session does not clear it; an explicit pair does. The
            // selected row lists this flag-off unit as legacy firmware.
            try receive(transport, ["type": "glasses_ready", "sid": "automatic"])
            XCTAssertTrue(pairingStore.isRejected)
            store.set("bluetooth", "pending_device_name", "MENTRA_LIVE_BLE_ABCD")
            store.set("bluetooth", "pending_device_secure_pairing_capable", false)
            try receive(transport, ["type": "glasses_ready", "sid": "explicit"])
            XCTAssertEqual(pairingStore.state, .normal)
        }
    }

    func testPhoneHelloOnEverySecureSessionAndPairSelectOnlyOnAnExplicitAttempt() throws {
        try withPairingTransport { transport, _, store in
            let securePairingInfo: [String: Any] = [
                "type": "pairing_info", "secure_pairing_capable": true, "protocol_version": 4,
                "had_previous_bond": true, "owner_committed": true, "auto_audio": true,
            ]
            var pairingInfoBodies: [[String: Any]] = []
            let sink = Bridge.addEventSink { event, body in
                if event == "pairing_info" { pairingInfoBodies.append(body) }
            }
            defer { Bridge.removeEventSink(sink) }

            // Automatic reconnect: hello only.
            try receive(transport, securePairingInfo)
            try receive(transport, securePairingInfo)
            let types = transport.commands.compactMap { $0["type"] as? String }
            XCTAssertEqual(types.filter { $0 == "phone_hello" }.count, 1)
            XCTAssertFalse(types.contains("pair_select"))
            let hello = transport.commands.first { $0["type"] as? String == "phone_hello" }
            XCTAssertEqual(hello?["pairing_protocol"] as? Int, 4)
            XCTAssertEqual(pairingInfoBodies.last?["auto_audio"] as? Bool, true)
            XCTAssertNil(pairingInfoBodies.last?["awaiting_confirm"])
            XCTAssertNil(pairingInfoBodies.last?["retained_owner_link"])

            // An explicit attempt on a new session also selects this phone.
            transport.cleanup()
            let explicitTransport = SessionReadinessTransport()
            defer { explicitTransport.cleanup() }
            store.set("bluetooth", "pending_device_name", "MENTRA_LIVE_BLE_ABCD")
            store.set("bluetooth", "pending_device_secure_pairing_capable", true)
            try receive(explicitTransport, securePairingInfo)
            try receive(explicitTransport, securePairingInfo)
            let explicitTypes = explicitTransport.commands.compactMap { $0["type"] as? String }
            XCTAssertEqual(explicitTypes.filter { $0 == "phone_hello" }.count, 1)
            XCTAssertEqual(explicitTypes.filter { $0 == "pair_select" }.count, 1)
        }
    }

    func testLegacyFirmwareGetsNoPairingProtocolMessages() throws {
        try withPairingTransport { transport, _, store in
            store.set("bluetooth", "mentra_live_secure_firmware", false)
            store.set("bluetooth", "pending_device_name", "MENTRA_LIVE_BLE_ABCD")
            try receive(transport, ["type": "pairing_info", "had_previous_bond": false])
            let types = transport.commands.compactMap { $0["type"] as? String }
            XCTAssertFalse(types.contains("phone_hello"))
            XCTAssertFalse(types.contains("pair_select"))
        }
    }

    func testError14OnAnExplicitAttemptAsksToForgetThePairingWithItsCode() throws {
        try withPairingTransport { transport, _, store in
            var failures: [[String: Any]] = []
            let sink = Bridge.addEventSink { event, body in
                if event == "pair_failure" { failures.append(body) }
            }
            defer { Bridge.removeEventSink(sink) }
            MentraLive.clearStaleIosBondPrompt()
            defer { MentraLive.clearStaleIosBondPrompt() }

            let error14 = NSError(domain: CBErrorDomain, code: CBError.peerRemovedPairingInformation.rawValue)
            store.set("bluetooth", "pending_device_name", "MENTRA_LIVE_BLE_ABCD")
            XCTAssertTrue(transport.stopAfterConnectFailure(error14))
            XCTAssertEqual(failures.count, 1)
            XCTAssertEqual(failures.first?["code"] as? String, "ios_forget_pairing")
            XCTAssertEqual(failures.first?["error"] as? String, "errors:pairingCouldNotStart")
            // An explicit attempt never counts toward a rejection.
            XCTAssertEqual(MentraLivePairingStateStore.shared.state, .normal)

            // On an automatic reconnect error 14 is one strike, not a prompt.
            store.set("bluetooth", "pending_device_name", "")
            store.set("bluetooth", "mentra_live_secure_firmware", true)
            _ = transport.stopAfterConnectFailure(error14)
            XCTAssertEqual(failures.count, 1)
            XCTAssertEqual(MentraLivePairingStateStore.shared.state, .normal)
        }
    }

    // MARK: - Pairing readiness by target capability

    private func runMainLoop(until condition: () -> Bool, timeout: TimeInterval = 3) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
    }

    private func ready(_ store: ObservableStore) -> Bool {
        store.get("glasses", "fullyBooted") as? Bool == true
    }

    /// An explicit pair to the row `capability` (nil when the row did not know it).
    private func startExplicitPair(_ store: ObservableStore, capability: Bool?) {
        store.set("glasses", "fullyBooted", false)
        store.set("bluetooth", "pending_device_name", "MENTRA_LIVE_BLE_ABCD")
        store.set("bluetooth", "pending_device_secure_pairing_capable", capability.map { $0 as Any } ?? "")
    }

    func testUnknownCapabilityWithoutPairingInfoIsReportedReadyAfterTheWait() throws {
        try withPairingTransport { transport, _, store in
            transport.unknownCapabilityPairingInfoWaitMs = 50
            startExplicitPair(store, capability: nil)
            try receive(transport, ["type": "glasses_ready", "sid": "legacy"])
            XCTAssertFalse(ready(store), "readiness waits, bounded, for pairing_info")

            runMainLoop { self.ready(store) }
            XCTAssertTrue(ready(store), "no pairing_info: legacy firmware, reported ready")
            let types = transport.commands.compactMap { $0["type"] as? String }
            XCTAssertFalse(types.contains("pair_select"))
        }
    }

    func testUnknownCapabilityWithASecurePairingInfoFollowsTheSecureRule() throws {
        try withPairingTransport { transport, _, store in
            var failures = 0
            let sink = Bridge.addEventSink { event, _ in
                if event == "pair_failure" { failures += 1 }
            }
            defer { Bridge.removeEventSink(sink) }
            startExplicitPair(store, capability: nil)
            try receive(transport, ["type": "glasses_ready", "sid": "secure"])
            XCTAssertFalse(ready(store))

            try receive(transport, [
                "type": "pairing_info", "secure_pairing_capable": true, "owner_committed": false,
                "protocol_version": 4,
            ])
            XCTAssertFalse(ready(store), "secure firmware: ready only after the owner commit")
            let types = transport.commands.compactMap { $0["type"] as? String }
            XCTAssertEqual(types.filter { $0 == "pair_select" }.count, 1)

            // The unknown-capability wait no longer applies.
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            XCTAssertFalse(ready(store))

            try receive(transport, [
                "type": "pairing_info", "secure_pairing_capable": true, "owner_committed": true,
                "protocol_version": 4,
            ])
            XCTAssertTrue(ready(store))
            XCTAssertEqual(failures, 0)
        }
    }

    func testUnknownCapabilityWithALegacyPairingInfoIsReadyAtOnce() throws {
        try withPairingTransport { transport, _, store in
            startExplicitPair(store, capability: nil)
            try receive(transport, ["type": "glasses_ready", "sid": "legacy"])
            XCTAssertFalse(ready(store))
            try receive(transport, ["type": "pairing_info", "had_previous_bond": false])
            XCTAssertTrue(ready(store))
        }
    }

    func testTheSelectedRowDecidesTheSecureRuleNotTheSession() throws {
        try withPairingTransport { transport, _, store in
            // The row listed legacy firmware: no owner-commit wait and no pair_select, even if
            // the glasses then report secure firmware.
            startExplicitPair(store, capability: false)
            try receive(transport, ["type": "pairing_info", "secure_pairing_capable": true, "protocol_version": 4])
            try receive(transport, ["type": "glasses_ready", "sid": "row_legacy"])
            XCTAssertTrue(ready(store))
            XCTAssertFalse(transport.commands.contains { $0["type"] as? String == "pair_select" })

            // A secure row waits for the owner commit.
            transport.cleanup()
            let secureTransport = SessionReadinessTransport()
            DeviceManager.shared.sgc = secureTransport
            defer { secureTransport.cleanup() }
            startExplicitPair(store, capability: true)
            try receive(secureTransport, ["type": "glasses_ready", "sid": "row_secure"])
            XCTAssertFalse(ready(store))
            try receive(secureTransport, [
                "type": "pairing_info", "secure_pairing_capable": true, "owner_committed": true,
                "protocol_version": 4,
            ])
            XCTAssertTrue(ready(store))
        }
    }

    func testAReadySessionWithoutPairingInfoClearsTheSecureFirmwareFlag() throws {
        try withPairingTransport { transport, _, store in
            transport.secureFirmwareRefreshMs = 50
            store.set("bluetooth", "mentra_live_secure_firmware", true)
            store.set("glasses", "fullyBooted", false)
            try receive(transport, ["type": "glasses_ready", "sid": "rolled_back"])
            XCTAssertTrue(ready(store))
            runMainLoop { store.get("bluetooth", "mentra_live_secure_firmware") as? Bool == false }
            XCTAssertEqual(store.get("bluetooth", "mentra_live_secure_firmware") as? Bool, false)
        }
    }

    func testASecurePairingInfoKeepsTheSecureFirmwareFlag() throws {
        try withPairingTransport { transport, _, store in
            transport.secureFirmwareRefreshMs = 50
            store.set("bluetooth", "mentra_live_secure_firmware", false)
            store.set("glasses", "fullyBooted", false)
            try receive(transport, ["type": "glasses_ready", "sid": "secure"])
            try receive(transport, ["type": "pairing_info", "secure_pairing_capable": true, "protocol_version": 4])
            runMainLoop { store.get("bluetooth", "mentra_live_secure_firmware") as? Bool == true }
            RunLoop.main.run(until: Date().addingTimeInterval(0.15))
            XCTAssertEqual(store.get("bluetooth", "mentra_live_secure_firmware") as? Bool, true)
        }
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

    func testRestartedProcessAnsweringAnOlderCopyIsHandledAndThePendingExchangeStillCounts() throws {
        try withReadinessTransport { transport, receive, versionRequests in
            try receive(["C": "sr_hrt", "B": ["ready": 1]])
            let first = try XCTUnwrap(transport.phoneReadyIds().last)
            try receive(["type": "glasses_ready", "sid": "booted", "readyId": first])
            try receive(["type": "version_info_1", "sid": "restarted", "build_number": "302010073"])
            let second = try XCTUnwrap(transport.phoneReadyIds().last)

            // The restarted process reset for a buffered copy of the old exchange, then resets
            // again for the pending one: both answers follow a reset.
            try receive(["type": "glasses_ready", "sid": "restarted", "readyId": first])
            XCTAssertEqual(versionRequests(), 2)
            try receive(["type": "glasses_ready", "sid": "restarted", "readyId": second])
            XCTAssertEqual(versionRequests(), 3)
            try receive(["type": "glasses_ready", "sid": "restarted", "readyId": second])
            XCTAssertEqual(versionRequests(), 3)
        }
    }

    func testReadinessExchangeEndsWithTheBleSession() throws {
        try withReadinessTransport { transport, receive, _ in
            try receive(["C": "sr_hrt", "B": ["ready": 1]])
            let first = try XCTUnwrap(transport.phoneReadyIds().last)
            transport.cleanup()
            DeviceStore.shared.store.set("glasses", "fullyBooted", false)

            try receive(["C": "sr_hrt", "B": ["ready": 1]])
            XCTAssertNotEqual(try XCTUnwrap(transport.phoneReadyIds().last), first)
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
