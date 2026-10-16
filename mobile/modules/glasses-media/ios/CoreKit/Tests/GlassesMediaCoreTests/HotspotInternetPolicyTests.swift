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

    func testUnknownSSIDCannotEstablishRestoredWifi() throws {
        XCTAssertNil(HotspotInternetPolicy.route(satisfied: true, cellular: false, ethernet: false,
                                                 restoredWifiSSID: "Office", glassesSSID: nil))
        let wait = HotspotInternetObservation(generation: 10, glassesSSID: "MentraLive-03BE")
        let path = try XCTUnwrap(wait.beginPath(currentGeneration: 10))
        XCTAssertNil(wait.restoredWifiRoute(ssid: nil, pathRevision: path, currentGeneration: 10))
        XCTAssertNil(wait.restoredWifiRoute(ssid: "MentraLive-03BE", pathRevision: path, currentGeneration: 10))
        XCTAssertEqual(wait.restoredWifiRoute(ssid: "Office", pathRevision: path, currentGeneration: 10), "wifi")
    }

    func testAChangedPathInvalidatesItsPendingSSIDCallback() throws {
        let wait = HotspotInternetObservation(generation: 10, glassesSSID: "MentraLive-03BE")
        let oldPath = try XCTUnwrap(wait.beginPath(currentGeneration: 10))
        let newPath = try XCTUnwrap(wait.beginPath(currentGeneration: 10))
        XCTAssertNil(wait.restoredWifiRoute(ssid: "Office", pathRevision: oldPath, currentGeneration: 10))
        XCTAssertEqual(wait.restoredWifiRoute(ssid: "Office", pathRevision: newPath, currentGeneration: 10), "wifi")
    }

    func testLaterSessionCannotSettlePreviousObservation() throws {
        let wait = HotspotInternetObservation(generation: 10, glassesSSID: "MentraLive-03BE")
        let path = try XCTUnwrap(wait.beginPath(currentGeneration: 10))
        XCTAssertNil(wait.beginPath(currentGeneration: 11))
        XCTAssertNil(wait.restoredWifiRoute(ssid: "Office", pathRevision: path, currentGeneration: 11))
    }

    func testTimeoutAndCancellationSettleOnlyOnceAndRejectLateCallbacks() throws {
        for _ in ["timeout", "cancel"] {
            let wait = HotspotInternetObservation(generation: 10, glassesSSID: "MentraLive-03BE")
            let path = try XCTUnwrap(wait.beginPath(currentGeneration: 10))
            XCTAssertTrue(wait.settle())
            XCTAssertFalse(wait.settle())
            XCTAssertNil(wait.beginPath(currentGeneration: 10))
            XCTAssertNil(wait.restoredWifiRoute(ssid: "Office", pathRevision: path, currentGeneration: 10))
        }
    }

    func testConcurrentLeaveCallersShareOriginalOwnerUntilRecoverySettles() {
        var owner: String? = "original"
        var released = 0
        var replied: [Int] = []
        let leave = HotspotLeaveCompletion { owner = nil; released += 1 }
        leave.append { _ in XCTAssertNil(owner); replied.append(1) }
        leave.append { _ in XCTAssertNil(owner); replied.append(2) }
        XCTAssertEqual(owner, "original")
        XCTAssertTrue(replied.isEmpty)
        leave.complete(.success(()))
        leave.complete(.success(()))
        XCTAssertEqual(released, 1)
        XCTAssertEqual(replied, [1, 2])
    }

    func testCancellingRecoveryRepliesOnceWithoutReleasingALaterOwner() throws {
        var owner: String? = "original"
        var replies = 0
        let leave = HotspotLeaveCompletion { if owner == "original" { owner = nil } }
        let wait = HotspotInternetObservation(generation: 10, glassesSSID: "MentraLive-03BE")
        let path = try XCTUnwrap(wait.beginPath(currentGeneration: 10))
        leave.append { _ in replies += 1 }
        if wait.settle() { leave.complete(.success(())) }
        owner = "later"
        XCTAssertFalse(wait.settle())
        XCTAssertNil(wait.restoredWifiRoute(ssid: "Office", pathRevision: path, currentGeneration: 10))
        leave.complete(.success(()))
        XCTAssertEqual(owner, "later")
        XCTAssertEqual(replies, 1)
    }

    func testUnprovenAssociationCleanupRetainsOwnerForLaterLeave() {
        var released = false
        let leave = HotspotLeaveCompletion { released = true }
        var receivedFailure = false
        leave.append { if case .failure = $0 { receivedFailure = true } }
        leave.complete(.failure(LocalMediaError("Current association is unknown")))
        XCTAssertTrue(receivedFailure)
        XCTAssertFalse(released)
    }

    func testTimeoutOrCancelJoinsPendingNativeReadBeforeReleasingTheOwner() {
        let wait = HotspotInternetObservation(generation: 10, glassesSSID: "MentraLive-03BE")
        XCTAssertTrue(wait.beginSSIDRead())
        XCTAssertFalse(wait.beginSSIDRead())
        XCTAssertTrue(wait.settle())
        var released = false
        wait.afterSSIDRead { released = true }
        XCTAssertFalse(released)
        XCTAssertFalse(wait.beginSSIDRead())
        wait.completeSSIDRead()
        XCTAssertTrue(released)
        XCTAssertFalse(wait.settle())
    }
}
