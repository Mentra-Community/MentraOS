@testable import MentraBluetoothSDK
import XCTest

@MainActor
final class NimoDiscoveryTests: XCTestCase {
    @MainActor
    private final class Radio {
        var connected: [String] = []
        var events: [String] = []
        var found: [String] = []
        var selected: String?
        lazy var discovery: NimoDiscovery<String> = NimoDiscovery(
            register: { [unowned self] in self.events.append("register") },
            connected: { [unowned self] in self.events.append("retrieve"); return self.connected },
            scan: { [unowned self] in self.events.append("scan") },
            stop: { [unowned self] in self.events.append("stop") },
            name: { $0 },
            found: { [unowned self] _, name, _ in
                found.append(name)
                if selected == name { discovery.cancel() }
            }
        )
    }

    func testAlreadyConnectedClassicDeviceIsFoundWithoutAdvertisement() {
        let radio = Radio()
        radio.connected = ["NIMO_1234", "NIMO_1234_BLE", "Unrelated"]
        radio.discovery.start()
        XCTAssertEqual(radio.events, ["register", "retrieve", "scan"])
        XCTAssertEqual(radio.found, ["NIMO_1234"])
    }

    func testPairingInSettingsAfterScanStartedDeliversDevice() {
        let radio = Radio()
        radio.discovery.start()
        XCTAssertTrue(radio.found.isEmpty)
        // Same entry point as connectionEventDidOccur(.peerConnected).
        radio.discovery.receive("NIMO_5678")
        XCTAssertEqual(radio.found, ["NIMO_5678"])
    }

    func testSelectionFromConnectedSnapshotStopsBeforeStartingBleScan() {
        let radio = Radio()
        radio.selected = "NIMO_5678"
        radio.connected = ["NIMO_1234", "NIMO_5678", "NIMO_9999"]
        radio.discovery.start()
        XCTAssertEqual(radio.found, ["NIMO_1234", "NIMO_5678"])
        XCTAssertEqual(radio.events, ["register", "retrieve", "stop"])
        XCTAssertFalse(radio.discovery.active)
    }

    func testCancelledDiscoveryIgnoresQueuedEventsAndCanRestart() {
        let radio = Radio()
        radio.discovery.start()
        radio.discovery.cancel()
        radio.discovery.receive("NIMO_1234")
        XCTAssertTrue(radio.found.isEmpty)
        radio.connected = ["NIMO_1234"]
        radio.discovery.start()
        XCTAssertEqual(radio.found, ["NIMO_1234"])
    }

    func testBleFallbackUsesAdvertisementNameAndPreservesSignalStrength() {
        var found: [String] = []
        var signal: Int?
        let discovery = NimoDiscovery<String>(
            register: {}, connected: { [] }, scan: {}, stop: {}, name: { _ in nil },
            found: { _, name, rssi in found.append(name); signal = rssi }
        )
        discovery.start()
        discovery.receive("uuid", advertisedName: "NiMo_1234_bLe", rssi: -60)
        discovery.receive("uuid", advertisedName: "Unrelated", rssi: -60)
        discovery.receive("uuid")
        XCTAssertTrue(found.isEmpty)
        discovery.receive("uuid", advertisedName: "NiMo_1234", rssi: -55)
        XCTAssertEqual(found, ["NiMo_1234"])
        XCTAssertEqual(signal, -55)
    }
}
