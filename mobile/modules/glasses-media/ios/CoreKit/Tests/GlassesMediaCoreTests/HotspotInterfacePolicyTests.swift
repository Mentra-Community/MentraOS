@testable import GlassesMediaCore
import XCTest

final class HotspotInterfacePolicyTests: XCTestCase {
    private let gateway = "192.168.43.1"
    /// A Mac with built-in Ethernet on en0 (index 4) and Wi-Fi on en1 (index 6).
    private let macLinks = ["lo0": 1, "en0": 4, "en1": 6]
    private let ethernet = HotspotInterfaceAddress(name: "en0", isUp: true, ipv4: "192.168.1.20")
    private let wifi = HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "192.168.43.20")
    private let wifiBinding = HotspotInterfaceBinding(interface: "en1", index: 6, address: "192.168.43.20")
    private let macReports = [
        HotspotInterfaceReport(name: "en0", index: 4, isWifi: false),
        HotspotInterfaceReport(name: "en1", index: 6, isWifi: true),
        HotspotInterfaceReport(name: "lo0", index: 1, isWifi: false),
    ]

    private func snapshot(_ rows: [HotspotInterfaceAddress], links: [String: Int]? = nil) -> HotspotInterfaceSnapshot {
        HotspotInterfaceSnapshot(links: links ?? macLinks, addresses: rows)
    }

    private func identity(_ reports: [HotspotInterfaceReport]...) -> HotspotWifiIdentity {
        var identity = HotspotWifiIdentity()
        reports.forEach { identity.observe($0) }
        return identity
    }

    /// Sample interfaces into the session identity, then select, as GlassesHotspotNetwork does.
    private func select(_ sample: HotspotInterfaceSnapshot, _ identity: inout HotspotWifiIdentity,
                        gateway: String? = "192.168.43.1") -> HotspotInterfaceBinding?
    {
        identity.observe(sample)
        return HotspotInterfacePolicy.select(snapshot: sample, identity: identity, gateway: gateway)
    }

    private func select(_ rows: [HotspotInterfaceAddress], _ reports: [HotspotInterfaceReport],
                        gateway: String? = "192.168.43.1") -> HotspotInterfaceBinding?
    {
        var session = identity(reports)
        return select(snapshot(rows), &session, gateway: gateway)
    }

    private func intact(_ binding: HotspotInterfaceBinding, _ sample: HotspotInterfaceSnapshot,
                        _ identity: inout HotspotWifiIdentity) -> Bool
    {
        identity.observe(sample)
        return HotspotInterfacePolicy.isIntact(binding, snapshot: sample, identity: identity)
    }

    func testMacEthernetOnEn0AndWifiOnEn1SelectsTheWifiHotspotAddress() {
        // The en0-only lookup returned nil here with a gateway, or the Ethernet address without one.
        XCTAssertEqual(select([ethernet, wifi], macReports), wifiBinding)
        XCTAssertEqual(select([ethernet, wifi], macReports, gateway: nil), wifiBinding)
    }

    func testIphoneWifiOnEn0IsStillSelected() {
        let rows = [
            HotspotInterfaceAddress(name: "pdp_ip0", isUp: true, ipv4: "10.44.5.6"),
            HotspotInterfaceAddress(name: "en0", isUp: true, ipv4: "192.168.43.142"),
        ]
        let reports = [HotspotInterfaceReport(name: "en0", index: 5, isWifi: true), HotspotInterfaceReport(name: "pdp_ip0", index: 2, isWifi: false)]
        var session = identity(reports)
        let sample = snapshot(rows, links: ["en0": 5, "pdp_ip0": 2])
        let expected = HotspotInterfaceBinding(interface: "en0", index: 5, address: "192.168.43.142")
        XCTAssertEqual(select(sample, &session), expected)
        XCTAssertEqual(select(sample, &session, gateway: nil), expected)
    }

    func testWifiIdentitySeenBeforeApplySurvivesPathsThatLaterOmitIt() {
        // At join, the Mac's Wi-Fi is still on its previous network and both paths list en1.
        var session = HotspotWifiIdentity()
        session.observe(macReports)
        session.observe([HotspotInterfaceReport(name: "en1", index: 6, isWifi: true)])
        let before = snapshot([ethernet, HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "192.168.1.31")])
        XCTAssertNil(select(before, &session), "the previous network is not the glasses subnet")
        // After apply the AP has no internet: the default path is Ethernet only and the
        // Wi-Fi-constrained path is empty. DHCP then gives en1 the exact glasses client address.
        session.observe([HotspotInterfaceReport(name: "en0", index: 4, isWifi: false)])
        session.observe([])
        XCTAssertNil(select(snapshot([ethernet, HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "169.254.9.9")]), &session))
        XCTAssertEqual(select(snapshot([ethernet, wifi]), &session), wifiBinding)
        // The pinned binding also tolerates the omission.
        XCTAssertTrue(intact(wifiBinding, snapshot([ethernet, wifi]), &session))
    }

    func testNoTrustedWifiIdentityInTheSessionFailsClosed() {
        // The correct DHCP address is present, but Network framework never called en1 Wi-Fi.
        var session = HotspotWifiIdentity()
        session.observe([HotspotInterfaceReport(name: "en0", index: 4, isWifi: false)])
        session.observe([])
        XCTAssertNil(select(snapshot([ethernet, wifi]), &session))
        XCTAssertNil(select([ethernet, wifi], []))
        // A report without a kernel index or name cannot establish identity.
        XCTAssertNil(select([ethernet, wifi], [HotspotInterfaceReport(name: "en1", index: 0, isWifi: true)]))
        XCTAssertTrue(identity([HotspotInterfaceReport(name: "en1", index: 0, isWifi: true)]).trusted.isEmpty)
        XCTAssertTrue(identity([HotspotInterfaceReport(name: "", index: 6, isWifi: true)]).trusted.isEmpty)
    }

    func testNonWifiReportRejectsTheNameForTheRestOfTheSession() {
        var session = identity(macReports)
        XCTAssertEqual(select(snapshot([ethernet, wifi]), &session), wifiBinding)
        session.observe([HotspotInterfaceReport(name: "en1", index: 6, isWifi: false)])
        XCTAssertNil(select(snapshot([ethernet, wifi]), &session))
        XCTAssertFalse(intact(wifiBinding, snapshot([ethernet, wifi]), &session))
        // Later positive reports do not clear contrary evidence within the session.
        session.observe(macReports)
        XCTAssertNil(select(snapshot([ethernet, wifi]), &session))
        // Conflicting reports in one update are also rejected.
        XCTAssertNil(select([ethernet, wifi], macReports + [HotspotInterfaceReport(name: "en1", index: 6, isWifi: false)]))
    }

    func testDetachedOrReplacedInterfaceLosesIdentityAndBinding() {
        // Detached: its AF_LINK row disappears. Returning later is not the same session evidence.
        var session = identity(macReports)
        XCTAssertTrue(intact(wifiBinding, snapshot([ethernet, wifi]), &session))
        XCTAssertFalse(intact(wifiBinding, snapshot([ethernet], links: ["lo0": 1, "en0": 4]), &session))
        XCTAssertNil(select(snapshot([ethernet, wifi]), &session))
        XCTAssertFalse(intact(wifiBinding, snapshot([ethernet, wifi]), &session))
        // A fresh positive report may identify the returned interface for a new discovery,
        // but the address verified before the detach stays lost.
        session.observe(macReports)
        XCTAssertEqual(select(snapshot([ethernet, wifi]), &session), wifiBinding)
        XCTAssertFalse(intact(wifiBinding, snapshot([ethernet, wifi]), &session))

        // Replaced: the name now belongs to another kernel interface with the glasses address.
        var replaced = identity(macReports)
        let other = snapshot([ethernet, wifi], links: ["lo0": 1, "en0": 4, "en1": 9])
        XCTAssertNil(select(other, &replaced))
        XCTAssertFalse(intact(wifiBinding, other, &replaced))
        // A report for the replacement must vouch for the new index; the old binding stays lost.
        var reported = identity(macReports)
        reported.observe([HotspotInterfaceReport(name: "en1", index: 9, isWifi: true)])
        XCTAssertEqual(select(other, &reported), HotspotInterfaceBinding(interface: "en1", index: 9, address: "192.168.43.20"))
        XCTAssertFalse(intact(wifiBinding, snapshot([ethernet, wifi]), &reported))
        // A replacement seen only in reports is also final for the earlier binding.
        var flipped = identity(macReports)
        flipped.observe([HotspotInterfaceReport(name: "en1", index: 9, isWifi: true)])
        flipped.observe([HotspotInterfaceReport(name: "en1", index: 6, isWifi: true)])
        XCTAssertFalse(intact(wifiBinding, snapshot([ethernet, wifi]), &flipped))
        // Selection itself checks the current index, even for an identity that has not sampled it.
        XCTAssertNil(HotspotInterfacePolicy.select(snapshot: other, identity: identity(macReports), gateway: gateway))
    }

    func testNewSessionStartsWithoutEarlierEvidence() {
        var first = identity(macReports)
        XCTAssertEqual(select(snapshot([ethernet, wifi]), &first), wifiBinding)
        var rejoin = HotspotWifiIdentity()
        XCTAssertNil(select(snapshot([ethernet, wifi]), &rejoin))
        XCTAssertFalse(intact(wifiBinding, snapshot([ethernet, wifi]), &rejoin))
        // Contrary evidence from an earlier session does not leak into the next one either.
        var rejected = identity([HotspotInterfaceReport(name: "en1", index: 6, isWifi: false)])
        XCTAssertNil(select(snapshot([ethernet, wifi]), &rejected))
        var next = identity(macReports)
        XCTAssertEqual(select(snapshot([ethernet, wifi]), &next), wifiBinding)
    }

    func testNonWifiInterfacesNeverQualifyEvenOnTheGlassesSubnet() {
        // Ethernet, VPN, bridge and loopback addresses on the hotspot /24 are not the hotspot link.
        for name in ["en0", "utun3", "bridge100", "lo0"] {
            let row = HotspotInterfaceAddress(name: name, isUp: true, ipv4: "192.168.43.50")
            var links = macLinks
            links[name] = links[name] ?? 20
            var session = identity(macReports + [HotspotInterfaceReport(name: name, index: links[name]!, isWifi: false)])
            XCTAssertNil(select(snapshot([row], links: links), &session), name)
            var unknown = HotspotWifiIdentity()
            XCTAssertNil(select(snapshot([row], links: links), &unknown), name)
        }
        // A stale Wi-Fi address cannot be replaced by an Ethernet address on the glasses subnet.
        let staleWifi = HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "192.168.1.30")
        let ethernetOnGlassesSubnet = HotspotInterfaceAddress(name: "en0", isUp: true, ipv4: "192.168.43.60")
        XCTAssertNil(select([ethernetOnGlassesSubnet, staleWifi], macReports))
    }

    func testAmbiguousWifiCandidatesFailClosed() {
        let second = HotspotInterfaceAddress(name: "en2", isUp: true, ipv4: "192.168.43.21")
        var session = identity(macReports + [HotspotInterfaceReport(name: "en2", index: 7, isWifi: true)])
        var links = macLinks
        links["en2"] = 7
        XCTAssertNil(select(snapshot([wifi, second], links: links), &session))
        // Two addresses on one Wi-Fi interface are also ambiguous.
        let alias = HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "192.168.43.21")
        XCTAssertNil(select([wifi, alias], macReports))
        // Without a gateway, any second private Wi-Fi address is ambiguous.
        XCTAssertNil(select([wifi, HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "10.0.0.5")], macReports, gateway: nil))
        // Duplicate rows for the same address are one candidate.
        XCTAssertEqual(select([wifi, wifi], macReports), wifiBinding)
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
        var session = identity(macReports)
        XCTAssertTrue(intact(wifiBinding, snapshot([ethernet, wifi]), &session))
        for rows in [
            [ethernet],
            [ethernet, HotspotInterfaceAddress(name: "en1", isUp: false, ipv4: "192.168.43.20")],
            [ethernet, HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "192.168.43.21")],
            [ethernet, HotspotInterfaceAddress(name: "en1", isUp: true, ipv4: "192.168.1.30")],
            // The same address on another interface never keeps the session or a rebind alive.
            [HotspotInterfaceAddress(name: "en0", isUp: true, ipv4: "192.168.43.20")],
        ] {
            var copy = session
            XCTAssertFalse(intact(wifiBinding, snapshot(rows), &copy))
        }
    }
}
