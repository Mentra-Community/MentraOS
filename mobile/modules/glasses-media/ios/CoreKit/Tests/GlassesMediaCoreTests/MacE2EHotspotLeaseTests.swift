#if MENTRA_E2E
    import Foundation
    @testable import GlassesMediaCore
    import XCTest

    final class MacE2EHotspotLeaseTests: XCTestCase {
        func testLeaseRequiresFreshMatchingNetworkAndConcreteClientAddress() throws {
            let lease = try JSONDecoder().decode(MacE2EHotspotLease.self, from: Data(#"{"ssid":"fixture","gateway":"192.168.43.1","address":"192.168.43.2","issuedAt":1000}"#.utf8))
            XCTAssertTrue(lease.matches(ssid: "fixture", gateway: "192.168.43.1", address: "192.168.43.2", now: 1050))
            for now in [999.0, 1301.0, .infinity, .nan] {
                XCTAssertFalse(lease.matches(ssid: "fixture", gateway: "192.168.43.1", address: "192.168.43.2", now: now))
            }
            XCTAssertFalse(lease.matches(ssid: "other", gateway: "192.168.43.1", address: "192.168.43.2", now: 1050))
            XCTAssertFalse(lease.matches(ssid: "fixture", gateway: nil, address: "192.168.43.2", now: 1050))
            XCTAssertFalse(lease.matches(ssid: "fixture", gateway: "192.168.44.1", address: "192.168.43.2", now: 1050))
            for address in [nil, "192.168.1.2", "192.168.43.1", "192.168.43.0", "192.168.43.255"] as [String?] {
                XCTAssertFalse(lease.matches(ssid: "fixture", gateway: "192.168.43.1", address: address, now: 1050))
            }
        }
    }
#endif
