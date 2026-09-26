@testable import GlassesMediaCore
import XCTest

final class HotspotInterfacePolicyTests: XCTestCase {
    private let gateway = "192.168.43.1"
    private let ethernet = HotspotInterfaceAddress(name: "en0", isUp: true, ipv4: "192.168.1.20")
    private let wifi = HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "192.168.43.20")
    /// Network framework's view of a Mac with built-in Ethernet on en0 and Wi-Fi on en1.
    private let macReports = [
        HotspotInterfaceReport(name: "en0", isWifi: false),
        HotspotInterfaceReport(name: "en1", isWifi: true),
        HotspotInterfaceReport(name: "lo0", isWifi: false),
    ]

    private func select(_ rows: [HotspotInterfaceAddress], _ reports: [HotspotInterfaceReport],
                        gateway: String? = "192.168.43.1") -> HotspotInterfaceBinding?
    {
        HotspotInterfacePolicy.select(addresses: rows, wifiInterfaces: HotspotInterfacePolicy.wifiInterfaces(reports), gateway: gateway)
    }

    func testMacEthernetOnEn0AndWifiOnEn1SelectsTheWifiHotspotAddress() {
        // The en0-only lookup returned nil here with a gateway, or the Ethernet address without one.
        let expected = HotspotInterfaceBinding(interface: "en1", address: "192.168.43.20")
        XCTAssertEqual(select([ethernet, wifi], macReports), expected)
        XCTAssertEqual(select([ethernet, wifi], macReports, gateway: nil), expected)
    }

    func testIphoneWifiOnEn0IsStillSelected() {
        let rows = [
            HotspotInterfaceAddress(name: "pdp_ip0", isUp: true, ipv4: "10.44.5.6"),
            HotspotInterfaceAddress(name: "en0", isUp: true, ipv4: "192.168.43.142"),
        ]
        let reports = [HotspotInterfaceReport(name: "en0", isWifi: true), HotspotInterfaceReport(name: "pdp_ip0", isWifi: false)]
        XCTAssertEqual(select(rows, reports), HotspotInterfaceBinding(interface: "en0", address: "192.168.43.142"))
        XCTAssertEqual(select(rows, reports, gateway: nil), HotspotInterfaceBinding(interface: "en0", address: "192.168.43.142"))
    }

    func testNonWifiInterfacesNeverQualifyEvenOnTheGlassesSubnet() {
        // Ethernet, VPN, bridge and loopback addresses on the hotspot /24 are not the hotspot link.
        for name in ["en0", "utun3", "bridge100", "lo0"] {
            let row = HotspotInterfaceAddress(name: name, isUp: true, ipv4: "192.168.43.50")
            XCTAssertNil(select([row], macReports + [HotspotInterfaceReport(name: name, isWifi: false)]), name)
            XCTAssertNil(select([row], []), name)
        }
        // A stale Wi-Fi address cannot be replaced by an Ethernet address on the glasses subnet.
        let staleWifi = HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "192.168.1.30")
        let ethernetOnGlassesSubnet = HotspotInterfaceAddress(name: "en0", isUp: true, ipv4: "192.168.43.60")
        XCTAssertNil(select([ethernetOnGlassesSubnet, staleWifi], macReports))
    }

    func testMissingOrConflictingWifiIdentityFailsClosed() {
        XCTAssertNil(select([ethernet, wifi], []))
        XCTAssertNil(select([ethernet, wifi], [HotspotInterfaceReport(name: "en0", isWifi: false)]))
        // One path calls en1 Wi-Fi and another does not: the identity is not established.
        let conflicting = macReports + [HotspotInterfaceReport(name: "en1", isWifi: false)]
        XCTAssertTrue(HotspotInterfacePolicy.wifiInterfaces(conflicting).isEmpty)
        XCTAssertNil(select([ethernet, wifi], conflicting))
        XCTAssertTrue(HotspotInterfacePolicy.wifiInterfaces([HotspotInterfaceReport(name: "", isWifi: true)]).isEmpty)
    }

    func testAmbiguousWifiCandidatesFailClosed() {
        let second = HotspotInterfaceAddress(name: "en2", isUp: true, ipv4: "192.168.43.21")
        let reports = macReports + [HotspotInterfaceReport(name: "en2", isWifi: true)]
        XCTAssertNil(select([wifi, second], reports))
        // Two addresses on one Wi-Fi interface are also ambiguous.
        let alias = HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "192.168.43.21")
        XCTAssertNil(select([wifi, alias], macReports))
        // Without a gateway, any second private Wi-Fi address is ambiguous.
        XCTAssertNil(select([wifi, HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "10.0.0.5")], macReports, gateway: nil))
        // Duplicate rows for the same address are one candidate.
        XCTAssertEqual(select([wifi, wifi], macReports), HotspotInterfaceBinding(interface: "en1", address: "192.168.43.20"))
    }

    func testDownOrNonPrivateOrNonIpv4WifiRowsAreRejected() {
        for row in [
            HotspotInterfaceAddress(name: "en1", isUp: false, ipv4: "192.168.43.20"),
            HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "169.254.3.4"),
            HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "8.8.8.8"),
            HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "fe80::1"),
            HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "host.local"),
        ] {
            XCTAssertNil(select([ethernet, row], macReports), row.ipv4)
            XCTAssertNil(select([ethernet, row], macReports, gateway: nil), row.ipv4)
        }
    }

    func testStaleDhcpAndNonClientAddressesOnWifiAreRejected() {
        for address in ["192.168.1.30", "192.168.44.20", "192.168.43.0", "192.168.43.1", "192.168.43.255"] {
            let row = HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: address)
            XCTAssertNil(select([ethernet, row], macReports), address)
        }
        // An invalid gateway admits no client address.
        XCTAssertNil(select([ethernet, HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "8.8.8.2")], macReports, gateway: "8.8.8.1"))
        XCTAssertNil(select([ethernet, wifi], macReports, gateway: "not-an-ip"))
    }

    func testSelectedAddressStillRequiresExactSsidForReuse() {
        let binding = select([ethernet, wifi], macReports)
        XCTAssertTrue(LocalMediaPolicy.canReuseHotspot(requestedSSID: "glasses", currentSSID: "glasses", address: binding?.address, gateway: gateway))
        for current in [nil, "", "home", "Glasses"] as [String?] {
            XCTAssertFalse(LocalMediaPolicy.canReuseHotspot(requestedSSID: "glasses", currentSSID: current, address: binding?.address, gateway: gateway))
        }
    }

    func testBindingIsLostWhenItsInterfaceOrAddressChanges() {
        let binding = HotspotInterfaceBinding(interface: "en1", address: "192.168.43.20")
        XCTAssertTrue(HotspotInterfacePolicy.isIntact(binding, addresses: [ethernet, wifi], reports: macReports))
        // Reports can omit the link on a local-only path; absence is not contrary evidence.
        XCTAssertTrue(HotspotInterfacePolicy.isIntact(binding, addresses: [ethernet, wifi], reports: []))
        for rows in [
            [ethernet],
            [ethernet, HotspotInterfaceAddress(name: "en1", isUp: false, ipv4: "192.168.43.20")],
            [ethernet, HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "192.168.43.21")],
            [ethernet, HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "192.168.1.30")],
            // The same address on another interface never keeps the session or a rebind alive.
            [HotspotInterfaceAddress(name: "en0", isUp: true, ipv4: "192.168.43.20")],
        ] {
            XCTAssertFalse(HotspotInterfacePolicy.isIntact(binding, addresses: rows, reports: macReports))
        }
        XCTAssertFalse(HotspotInterfacePolicy.isIntact(binding, addresses: [ethernet, wifi],
                                                       reports: [HotspotInterfaceReport(name: "en1", isWifi: false)]))
    }
}
