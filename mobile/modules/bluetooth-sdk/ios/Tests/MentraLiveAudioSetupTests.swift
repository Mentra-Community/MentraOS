@testable import MentraBluetoothSDK
import XCTest

@MainActor
private final class AudioSetupTransport: MentraLive {
    var commands: [[String: Any]] = []

    override func sendJson(_ jsonOriginal: [String: Any], wakeUp _: Bool, requireAck _: Bool) {
        commands.append(jsonOriginal)
    }
}

/// `GlassesStatus.audioSetup` wiring: the Mentra Live driver on iOS and the shared default for
/// every other model.
@MainActor
final class MentraLiveAudioSetupTests: XCTestCase {
    private let phoneAudioKeys = ["bluetoothClassicConnected", "bluetoothClassicProfilesConnected", "bluetoothAudioRouted"]

    private func withTransport(
        _ body: (AudioSetupTransport, ObservableStore, _ clock: (Int) -> Void) throws -> Void
    ) rethrows {
        let store = DeviceStore.shared.store
        let saved = ["bluetooth", "glasses"].map { ($0, store.getCategory($0)) }
        let previous = DeviceManager.shared.sgc
        UserDefaults.standard.removeObject(forKey: MentraLivePairingStateStore.defaultsKey)
        MentraLivePairingStateStore.shared.resetForTest()
        store.set("glasses", "fullyBooted", false)
        for key in phoneAudioKeys {
            store.set("glasses", key, false)
        }
        store.set("bluetooth", "pending_device_name", "")
        store.set("bluetooth", "pending_device_address", "")
        store.set("bluetooth", "pending_device_secure_pairing_capable", "")
        store.set("glasses", "audioSetup", GlassesAudioSetupState.idle.toMap())
        let transport = AudioSetupTransport()
        DeviceManager.shared.sgc = transport
        var nowMs = 1_000_000
        transport.audioSetupNowMs = { nowMs }
        defer {
            transport.cleanup()
            DeviceManager.shared.sgc = previous
            UserDefaults.standard.removeObject(forKey: MentraLivePairingStateStore.defaultsKey)
            MentraLivePairingStateStore.shared.resetForTest()
            for (category, values) in saved {
                for key in store.getCategory(category).keys where values[key] == nil {
                    store.remove(category, key)
                }
                for (key, value) in values {
                    store.set(category, key, value)
                }
            }
        }
        try body(transport, store) { nowMs = $0 }
    }

    private func receive(_ transport: MentraLive, _ value: [String: Any]) throws {
        try transport.processReceivedData(JSONSerialization.data(withJSONObject: value))
    }

    private func audioSetup(_ store: ObservableStore) -> GlassesAudioSetupState? {
        GlassesAudioSetupState(map: store.get("glasses", "audioSetup"))
    }

    /// The audioSetup visible at the moment `fullyBooted` flips to true.
    private func audioSetupWhenReady(_ store: ObservableStore, _ action: () throws -> Void) rethrows -> GlassesAudioSetupState? {
        var seen: GlassesAudioSetupState?
        let listener = store.addListener { category, changes in
            guard category == "glasses", changes["fullyBooted"] as? Bool == true else { return }
            seen = GlassesAudioSetupState(map: store.get("glasses", "audioSetup"))
        }
        defer { store.removeListener(listener) }
        try action()
        return seen
    }

    func testAReconnectReportsConnectingWithReadinessThenFollowsTheGlassesReport() throws {
        try withTransport { transport, store, clock in
            var events: [[String: Any]] = []
            let sink = Bridge.addEventSink { event, body in
                if event == "audio_setup_changed", let state = body["state"] as? [String: Any] { events.append(state) }
            }
            defer { Bridge.removeEventSink(sink) }

            clock(1_000_000)
            let atReady = try audioSetupWhenReady(store) {
                try receive(transport, ["type": "glasses_ready", "sid": "reconnect"])
            }
            XCTAssertEqual(atReady, .connecting, "the ready update never carries a stale idle")
            XCTAssertEqual(events.last as NSDictionary?, ["state": "connecting"])

            clock(1_002_000)
            try receive(transport, ["type": "classic_link", "a2dp": true, "hfp": false])
            XCTAssertEqual(audioSetup(store), .connected)
            XCTAssertEqual(events.last as NSDictionary?, ["state": "connected"])
            let eventCount = events.count

            // The same report again is not a change.
            try receive(transport, ["type": "classic_link", "a2dp": true, "hfp": false])
            XCTAssertEqual(events.count, eventCount)

            // Audio lost after connected: the reconnect wait starts again from now.
            clock(1_060_000)
            try receive(transport, ["type": "classic_link", "a2dp": false, "hfp": false])
            XCTAssertEqual(audioSetup(store), .connecting)
            clock(1_069_999)
            try receive(transport, ["type": "classic_link", "a2dp": false, "hfp": false])
            XCTAssertEqual(audioSetup(store), .connecting)

            // The deadline timer gives up at the end of the wait.
            clock(1_069_950)
            try receive(transport, ["type": "classic_link", "a2dp": false, "hfp": false])
            clock(1_070_000)
            let deadline = Date().addingTimeInterval(2)
            while audioSetup(store) != .needsUserConnectInSettings, Date() < deadline {
                RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            }
            XCTAssertEqual(audioSetup(store), .needsUserConnectInSettings)
            XCTAssertEqual(events.last as NSDictionary?, ["state": "needs_user", "action": "connect_in_settings"])

            // The phone's own signals are enough on their own.
            store.set("glasses", "bluetoothAudioRouted", true)
            XCTAssertEqual(audioSetup(store), .connected)

            // Session drop.
            transport.cleanup()
            XCTAssertEqual(audioSetup(store), .idle)
            XCTAssertEqual(events.last as NSDictionary?, ["state": "idle"])
        }
    }

    func testAnExplicitPairOnOldFirmwareNeedsTheUserInTheReadyUpdate() throws {
        try withTransport { transport, store, _ in
            store.set("bluetooth", "pending_device_name", "MENTRA_LIVE_BLE_ABCD")
            store.set("bluetooth", "pending_device_secure_pairing_capable", false)
            let atReady = try audioSetupWhenReady(store) {
                try receive(transport, ["type": "glasses_ready", "sid": "legacy"])
            }
            XCTAssertEqual(atReady, .needsUserConnectInSettings)
            XCTAssertEqual(audioSetup(store), .needsUserConnectInSettings)

            store.set("glasses", "bluetoothClassicConnected", true)
            XCTAssertEqual(audioSetup(store), .connected)
        }
    }

    func testAnExplicitSecurePairWithAutoAudioWaitsForAudio() throws {
        try withTransport { transport, store, clock in
            store.set("bluetooth", "pending_device_name", "MENTRA_LIVE_BLE_ABCD")
            store.set("bluetooth", "pending_device_secure_pairing_capable", true)
            clock(2_000_000)
            try receive(transport, ["type": "glasses_ready", "sid": "secure"])
            XCTAssertEqual(audioSetup(store), .idle, "not ready before the owner commit")
            let atReady = try audioSetupWhenReady(store) {
                try receive(transport, [
                    "type": "pairing_info", "secure_pairing_capable": true, "owner_committed": true,
                    "auto_audio": true, "protocol_version": 4,
                ])
            }
            XCTAssertEqual(atReady, .connecting)
            // A both-down report does not shorten the 8 s wait.
            clock(2_001_000)
            try receive(transport, ["type": "classic_link", "a2dp": false, "hfp": false])
            XCTAssertEqual(audioSetup(store), .connecting)
            clock(2_008_000)
            try receive(transport, ["type": "classic_link", "a2dp": false, "hfp": false])
            XCTAssertEqual(audioSetup(store), .needsUserConnectInSettings)
        }
    }

    func testReadinessLostIsIdle() throws {
        try withTransport { transport, store, _ in
            try receive(transport, ["type": "glasses_ready", "sid": "first"])
            XCTAssertEqual(audioSetup(store), .connecting)
            // sr_hrt ready=0 and ASG restarts clear readiness on a live link.
            DeviceStore.shared.set("glasses", "fullyBooted", false)
            XCTAssertEqual(audioSetup(store), .idle)
        }
    }

    func testModelsWithoutADriverRuleAreNotApplicableInTheReadyUpdate() {
        let store = DeviceStore.shared.store
        let saved = store.getCategory("glasses")
        let previous = DeviceManager.shared.sgc
        DeviceManager.shared.sgc = nil
        defer {
            DeviceManager.shared.sgc = previous
            for key in store.getCategory("glasses").keys where saved[key] == nil {
                store.remove("glasses", key)
            }
            for (key, value) in saved {
                store.set("glasses", key, value)
            }
        }
        store.set("glasses", "fullyBooted", false)
        store.set("glasses", "audioSetup", GlassesAudioSetupState.idle.toMap())
        var events: [[String: Any]] = []
        let sink = Bridge.addEventSink { event, body in
            if event == "audio_setup_changed", let state = body["state"] as? [String: Any] { events.append(state) }
        }
        defer { Bridge.removeEventSink(sink) }

        let atReady = audioSetupWhenReady(store) {
            DeviceStore.shared.apply("glasses", "fullyBooted", true)
        }
        XCTAssertEqual(atReady, .notApplicable)
        XCTAssertEqual(events as [NSDictionary], [["state": "not_applicable"]])
        let snapshot = GlassesStatus(values: store.getCategory("glasses"))
        XCTAssertEqual(snapshot.audioSetup as NSDictionary?, ["state": "not_applicable"])
        XCTAssertEqual(snapshot.dictionary["audioSetup"] as? NSDictionary, ["state": "not_applicable"])

        DeviceStore.shared.apply("glasses", "fullyBooted", false)
        XCTAssertEqual(audioSetup(store), .idle)
        XCTAssertEqual(events.count, 2)
    }
}
