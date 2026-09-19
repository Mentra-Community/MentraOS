@testable import MentraBluetoothSDK
import XCTest

final class G1SerialIdentityTests: XCTestCase {
    private let serial = "S110LABD020021"
    private let left = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!
    private let other = UUID(uuidString: "22222222-2222-2222-2222-222222222222")!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() {
        suite = "G1SerialIdentityTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
    }

    func testSerialSurvivesAProcessRestartWithoutAnotherAdvertisement() throws {
        G1SerialIdentity(defaults: defaults).remember(serial: serial, peripheralID: left, searchID: "_74_")
        let reopened = try G1SerialIdentity(defaults: XCTUnwrap(UserDefaults(suiteName: suite)))
        XCTAssertEqual(reopened.resolve(peripheralID: left, searchID: "_74_"), serial)
    }

    func testNearbyPairWithTheSameShortPairingIdCannotReuseTheSerial() {
        let identity = G1SerialIdentity(defaults: defaults)
        identity.remember(serial: serial, peripheralID: left, searchID: "_74_")
        XCTAssertNil(identity.resolve(peripheralID: other, searchID: "_74_"))
        XCTAssertNil(identity.resolve(peripheralID: left, searchID: "_75_"))
        XCTAssertNil(identity.resolve(peripheralID: left, searchID: "NOT_SET"))
    }

    func testLegacyUuidOnlyPairingDoesNotInventASerial() {
        defaults.set(left.uuidString, forKey: "leftGlassUUID")
        XCTAssertNil(G1SerialIdentity(defaults: defaults).resolve(peripheralID: left, searchID: "_74_"))
    }

    func testForgetRemovesPersistedIdentity() {
        let identity = G1SerialIdentity(defaults: defaults)
        identity.remember(serial: serial, peripheralID: left, searchID: "_74_")
        identity.forget()
        XCTAssertNil(G1SerialIdentity(defaults: defaults).resolve(peripheralID: left, searchID: "_74_"))
    }

    func testInvalidSerialAndUnselectedDiscoveryAreNotPersisted() {
        let identity = G1SerialIdentity(defaults: defaults)
        for invalid in ["", "000000000000", left.uuidString, "74", "S1short"] {
            identity.remember(serial: invalid, peripheralID: left, searchID: "_74_")
            XCTAssertNil(identity.resolve(peripheralID: left, searchID: "_74_"))
        }
        identity.remember(serial: serial, peripheralID: left, searchID: "NOT_SET")
        XCTAssertNil(identity.resolve(peripheralID: left, searchID: "_74_"))
    }

    func testAdvertisementDecoderPreservesExistingG1SerialFormats() {
        for expected in [serial, "100LABD020021", "110LABD020021"] {
            XCTAssertEqual(G1SerialIdentity.decodeManufacturerData(Data(expected.utf8)), expected)
        }
        var terminated = Data(serial.utf8)
        terminated.append(contentsOf: [0, 65, 66])
        XCTAssertEqual(G1SerialIdentity.decodeManufacturerData(terminated), serial)
        XCTAssertNil(G1SerialIdentity.decodeManufacturerData(Data("Even G1_74_L_ABCDEF".utf8)))
        XCTAssertNil(G1SerialIdentity.decodeManufacturerData(Data()))
    }

    func testRestoredSerialProducesIdentificationAndTheNextDayHeartbeat() throws {
        let identity = G1SerialIdentity(defaults: defaults)
        identity.remember(serial: serial, peripheralID: left, searchID: "_74_")
        var tracker = BluetoothSdkAnalyticsTracker(simulatedModel: "Simulated Glasses")
        var status = AnalyticsGlassesSnapshot(connected: false, fullyBooted: false, model: "Even Realities G1", serialNumber: "")
        tracker.initialize(status, reportingDay: 100)
        status.serialNumber = try XCTUnwrap(identity.resolve(peripheralID: left, searchID: "_74_"))
        XCTAssertTrue(tracker.observe(status, reportingDay: 100).isEmpty)
        status.connected = true
        status.fullyBooted = true
        let connected = tracker.observe(status, reportingDay: 100)
        XCTAssertEqual(connected.map(\.name), ["bluetooth_sdk_glasses_connected", "bluetooth_sdk_glasses_identified"])
        XCTAssertEqual(connected.last?.properties["glasses_device_id"] as? String, serial)
        XCTAssertEqual(connected.last?.properties["glasses_device_id_type"] as? String, "manufacturing_serial")
        XCTAssertTrue(tracker.observe(status, reportingDay: 100).isEmpty)
        XCTAssertEqual(tracker.observe(status, reportingDay: 101).first?.properties["event_kind"] as? String, "glasses_heartbeat")
    }

    func testLateAdvertisementIdentifiesAnAlreadyConnectedLegacyPairing() throws {
        var tracker = BluetoothSdkAnalyticsTracker(simulatedModel: "Simulated Glasses")
        var status = AnalyticsGlassesSnapshot(connected: true, fullyBooted: true, model: "Even Realities G1", serialNumber: "")
        tracker.initialize(status, reportingDay: 100)
        let identity = G1SerialIdentity(defaults: defaults)
        try identity.remember(serial: XCTUnwrap(G1SerialIdentity.decodeManufacturerData(Data(serial.utf8))), peripheralID: left, searchID: "_74_")
        status.serialNumber = try XCTUnwrap(identity.resolve(peripheralID: left, searchID: "_74_"))
        let events = tracker.observe(status, reportingDay: 100)
        XCTAssertEqual(events.map(\.name), ["bluetooth_sdk_glasses_identified"])
        XCTAssertEqual(events[0].properties["glasses_device_id"] as? String, serial)
    }
}
