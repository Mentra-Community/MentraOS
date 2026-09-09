@testable import MentraBluetoothSDK
import XCTest

final class BluetoothSdkAnalyticsTrackerTests: XCTestCase {
    private var tracker = BluetoothSdkAnalyticsTracker(simulatedModel: "Simulated Glasses")

    private func snapshot(connected: Bool, model: String = "Mentra Live", serial: String = "") -> AnalyticsGlassesSnapshot {
        AnalyticsGlassesSnapshot(connected: connected, fullyBooted: connected, model: model, serialNumber: serial)
    }

    func testConnectThenSerialEmitsEachOncePerConnection() {
        tracker.initialize(snapshot(connected: false), utcDay: 100)
        XCTAssertEqual(tracker.observe(snapshot(connected: true), utcDay: 100).map(\.name), ["bluetooth_sdk_glasses_connected"])

        let identified = tracker.observe(snapshot(connected: true, serial: "MLAB0001"), utcDay: 100)
        XCTAssertEqual(identified.map(\.name), ["bluetooth_sdk_glasses_identified"])
        XCTAssertEqual(identified[0].properties["event_kind"] as? String, "glasses_identified")
        XCTAssertEqual(identified[0].properties["glasses_device_id"] as? String, "MLAB0001")
        XCTAssertEqual(identified[0].properties["glasses_is_simulated"] as? Bool, false)

        XCTAssertTrue(tracker.observe(snapshot(connected: true, serial: "MLAB0001"), utcDay: 100).isEmpty)

        _ = tracker.observe(snapshot(connected: false), utcDay: 100)
        XCTAssertEqual(
            tracker.observe(snapshot(connected: true, serial: "MLAB0001"), utcDay: 100).map(\.name),
            ["bluetooth_sdk_glasses_connected", "bluetooth_sdk_glasses_identified"]
        )
    }

    func testConnectedWaitsForTheModel() {
        tracker.initialize(snapshot(connected: false), utcDay: 100)
        XCTAssertTrue(tracker.observe(snapshot(connected: true, model: ""), utcDay: 100).isEmpty)
        let withModel = tracker.observe(snapshot(connected: true, model: "Even Realities G2"), utcDay: 100)
        XCTAssertEqual(withModel.map(\.name), ["bluetooth_sdk_glasses_connected"])
        XCTAssertEqual(withModel[0].properties["glasses_model"] as? String, "Even Realities G2")
        XCTAssertNil(withModel[0].properties["glasses_model_unresolved"])
    }

    func testConnectedWithoutModelIsCountedWhenTheConnectionEndsFirst() {
        tracker.initialize(snapshot(connected: false), utcDay: 100)
        _ = tracker.observe(snapshot(connected: true, model: ""), utcDay: 100)
        let ended = tracker.observe(snapshot(connected: false, model: ""), utcDay: 100)
        XCTAssertEqual(ended.map(\.name), ["bluetooth_sdk_glasses_connected"])
        XCTAssertEqual(ended[0].properties["glasses_model_unresolved"] as? Bool, true)
        XCTAssertNil(ended[0].properties["glasses_model"])
    }

    func testHeartbeatOncePerUtcDayWhileConnected() {
        tracker.initialize(snapshot(connected: false), utcDay: 100)
        _ = tracker.observe(snapshot(connected: true, serial: "MLAB0001"), utcDay: 100)
        XCTAssertTrue(tracker.observe(snapshot(connected: true, serial: "MLAB0001"), utcDay: 100).isEmpty)
        let nextDay = tracker.observe(snapshot(connected: true, serial: "MLAB0001"), utcDay: 101)
        XCTAssertEqual(nextDay.map(\.name), ["bluetooth_sdk_glasses_identified"])
        XCTAssertEqual(nextDay[0].properties["event_kind"] as? String, "glasses_heartbeat")
        XCTAssertTrue(tracker.observe(snapshot(connected: true, serial: "MLAB0001"), utcDay: 101).isEmpty)
    }

    func testInitializingWhileConnectedSuppressesDuplicateIdentificationButNotHeartbeats() {
        tracker.initialize(snapshot(connected: true, serial: "MLAB0001"), utcDay: 100)
        XCTAssertTrue(tracker.observe(snapshot(connected: true, serial: "MLAB0001"), utcDay: 100).isEmpty)
        XCTAssertEqual(tracker.observe(snapshot(connected: true, serial: "MLAB0001"), utcDay: 101)[0].properties["event_kind"] as? String, "glasses_heartbeat")

        var late = BluetoothSdkAnalyticsTracker(simulatedModel: "Simulated Glasses")
        late.initialize(snapshot(connected: true, serial: ""), utcDay: 100)
        XCTAssertEqual(late.observe(snapshot(connected: true, serial: "MLAB0001"), utcDay: 100)[0].properties["event_kind"] as? String, "glasses_identified")
    }

    func testPlaceholderSerialsIgnoredAndSimulatedFlagged() {
        tracker.initialize(snapshot(connected: false), utcDay: 100)
        let events = tracker.observe(snapshot(connected: true, model: "Simulated Glasses", serial: "0000"), utcDay: 100)
        XCTAssertEqual(events.map(\.name), ["bluetooth_sdk_glasses_connected"])
        XCTAssertEqual(events[0].properties["glasses_is_simulated"] as? Bool, true)
    }

    func testIdentificationCarriesKnownGlassesSoftwareVersions() {
        tracker.initialize(snapshot(connected: false), utcDay: 100)
        var full = snapshot(connected: true, serial: "MLAB0001")
        full.firmwareVersion = "26.9.3.0"
        full.mtkFirmwareVersion = "20260709"
        full.appVersion = "5.2.1"
        let identified = tracker.observe(full, utcDay: 100).first { $0.name == "bluetooth_sdk_glasses_identified" }
        XCTAssertEqual(identified?.properties["glasses_firmware_version"] as? String, "26.9.3.0")
        XCTAssertEqual(identified?.properties["glasses_mtk_firmware_version"] as? String, "20260709")
        XCTAssertEqual(identified?.properties["glasses_app_version"] as? String, "5.2.1")
        XCTAssertNil(identified?.properties["glasses_bes_firmware_version"])
        XCTAssertNil(identified?.properties["glasses_build_number"])
    }

    func testUtcDayFlooring() {
        XCTAssertEqual(BluetoothSdkAnalyticsTracker.utcDay(epochMillis: 0), 0)
        XCTAssertEqual(BluetoothSdkAnalyticsTracker.utcDay(epochMillis: 86_399_999), 0)
        XCTAssertEqual(BluetoothSdkAnalyticsTracker.utcDay(epochMillis: 86_400_000), 1)
        XCTAssertEqual(BluetoothSdkAnalyticsTracker.utcDay(epochMillis: -1), -1)
    }
}
