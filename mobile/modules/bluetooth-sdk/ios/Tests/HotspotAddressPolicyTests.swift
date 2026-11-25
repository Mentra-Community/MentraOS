@testable import MentraBluetoothSDK
import XCTest

final class HotspotAddressPolicyTests: XCTestCase {
    func testHotspotAddressWaitsForDhcpAfterSsidAssociation() {
        // The reported incident associated the glasses SSID while en0 still had the home-router IP.
        let addresses = ["192.168.1.10", "169.254.1.10", "192.168.43.142"]
        XCTAssertEqual(addresses.filter { HotspotAddressPolicy.isHotspotClientAddress($0, gateway: "192.168.43.1") }, ["192.168.43.142"])
        XCTAssertTrue(HotspotAddressPolicy.isHotspotClientAddress("10.5.6.8", gateway: "10.5.6.1"))
        for address in ["192.168.43.1", "192.168.43.0", "192.168.43.255", "192.168.43.256", "host.local"] {
            XCTAssertFalse(HotspotAddressPolicy.isHotspotClientAddress(address, gateway: "192.168.43.1"), address)
        }
        XCTAssertFalse(HotspotAddressPolicy.isHotspotClientAddress("8.8.8.2", gateway: "8.8.8.1"))
    }

    func testReusingHotspotRequiresExactSsidAndReportedGateway() {
        XCTAssertTrue(HotspotAddressPolicy.canReuseHotspot(requestedSSID: "glasses", currentSSID: "glasses", address: "192.168.43.2", gateway: "192.168.43.1"))
        for current in [nil, "", "home", "Glasses"] as [String?] {
            XCTAssertFalse(HotspotAddressPolicy.canReuseHotspot(requestedSSID: "glasses", currentSSID: current, address: "192.168.43.2", gateway: "192.168.43.1"))
        }
        XCTAssertFalse(HotspotAddressPolicy.canReuseHotspot(requestedSSID: "", currentSSID: "", address: "192.168.43.2", gateway: "192.168.43.1"))
        XCTAssertFalse(HotspotAddressPolicy.canReuseHotspot(requestedSSID: "glasses", currentSSID: "glasses", address: "192.168.43.2", gateway: nil))
    }

    func testReusingHotspotRejectsStaleDhcpAndNonClientAddresses() {
        for address in [nil, "192.168.1.2", "192.168.43.0", "192.168.43.1", "192.168.43.255", "host.local"] as [String?] {
            XCTAssertFalse(HotspotAddressPolicy.canReuseHotspot(requestedSSID: "glasses", currentSSID: "glasses", address: address, gateway: "192.168.43.1"))
        }
    }
}
