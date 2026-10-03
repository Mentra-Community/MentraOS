@testable import GlassesMediaCore
import XCTest

final class HotspotInternetPolicyTests: XCTestCase {
    func testWiredInternetCanCarryTeamsWhileWifiIsReservedForGlasses() {
        XCTAssertEqual(HotspotInternetPolicy.route(satisfied: true, cellular: false, ethernet: true), "ethernet")
    }

    func testCellularPhoneRouteRemainsUsable() {
        XCTAssertEqual(HotspotInternetPolicy.route(satisfied: true, cellular: true, ethernet: false), "cellular")
    }

    func testDisconnectedInterfacesCannotPassTheNetworkCheck() {
        XCTAssertNil(HotspotInternetPolicy.route(satisfied: false, cellular: true, ethernet: false))
        XCTAssertNil(HotspotInternetPolicy.route(satisfied: false, cellular: false, ethernet: true))
        XCTAssertNil(HotspotInternetPolicy.route(satisfied: false, cellular: false, ethernet: false, restoredWifiSSID: "Office"))
    }

    func testSatisfiedLocalWifiAloneDoesNotProveAnIndependentInternetRoute() {
        XCTAssertNil(HotspotInternetPolicy.route(satisfied: true, cellular: false, ethernet: false))
    }

    func testReleaseAcceptsOfficeWifiButNeverTheDepartingGlassesHotspot() {
        XCTAssertEqual(HotspotInternetPolicy.route(satisfied: true, cellular: false, ethernet: false,
                                                   restoredWifiSSID: "Office", glassesSSID: "MentraLive-03BE"), "wifi")
        XCTAssertNil(HotspotInternetPolicy.route(satisfied: true, cellular: false, ethernet: false,
                                                 restoredWifiSSID: "MentraLive-03BE", glassesSSID: "MentraLive-03BE"))
        XCTAssertNil(HotspotInternetPolicy.route(satisfied: true, cellular: false, ethernet: false, restoredWifiSSID: ""))
    }
}
