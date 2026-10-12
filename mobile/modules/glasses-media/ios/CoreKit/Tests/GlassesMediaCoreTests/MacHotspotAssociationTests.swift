@testable import GlassesMediaCore
import XCTest

final class MacHotspotAssociationTests: XCTestCase {
    private final class Wifi: MacWifiInterface {
        var ssid: String?
        var scans = 0
        var joins = 0
        var leaves = 0
        var beforeJoin: (() -> Void)?
        var onScan: (() -> Void)?
        var unreadable = false
        func name() throws -> String {
            "en1"
        }

        func currentSSID() throws -> String? {
            if unreadable { throw LocalMediaError("Location authorization was revoked") }
            return ssid
        }

        func network(ssid _: String) throws -> NSObject {
            scans += 1; onScan?(); return NSObject()
        }

        func associate(network _: NSObject, password _: String) throws {
            joins += 1; beforeJoin?(); ssid = "glasses"
        }

        func disassociate() {
            leaves += 1; ssid = nil
        }
    }

    func testAutomaticJoinUsesActualWifiInterfaceAndCleansOwnedAssociation() throws {
        let wifi = Wifi()
        let join = MacHotspotAssociation { wifi }
        XCTAssertEqual(try join.associate(ssid: "glasses", password: "private"), "en1")
        XCTAssertEqual(wifi.scans, 1)
        XCTAssertEqual(wifi.joins, 1)
        try join.leave()
        XCTAssertEqual(wifi.leaves, 1)
    }

    func testExistingUserAssociationIsReusedWithoutOwningItsRelease() throws {
        let wifi = Wifi(); wifi.ssid = "glasses"
        let join = MacHotspotAssociation { wifi }
        _ = try join.associate(ssid: "glasses", password: "private")
        try join.leave()
        XCTAssertEqual(wifi.joins, 0)
        XCTAssertEqual(wifi.leaves, 0)
    }

    func testUserReplacementConnectionIsNotDisconnected() throws {
        let wifi = Wifi()
        let join = MacHotspotAssociation { wifi }
        _ = try join.associate(ssid: "glasses", password: "private")
        wifi.ssid = "user-network"
        try join.leave()
        XCTAssertEqual(wifi.leaves, 0)
        XCTAssertEqual(wifi.ssid, "user-network")
    }

    func testAlreadyDisconnectedNetworkDoesNotBlockRelease() throws {
        let wifi = Wifi()
        let join = MacHotspotAssociation { wifi }
        _ = try join.associate(ssid: "glasses", password: "private")
        wifi.ssid = nil
        try join.leave()
        XCTAssertEqual(wifi.leaves, 0)
    }

    func testUnreadableCurrentNetworkRetainsCleanupForRetry() throws {
        let wifi = Wifi()
        let join = MacHotspotAssociation { wifi }
        _ = try join.associate(ssid: "glasses", password: "private")
        wifi.unreadable = true
        XCTAssertThrowsError(try join.leave())
        XCTAssertEqual(wifi.leaves, 0)
        wifi.unreadable = false
        try join.leave()
        XCTAssertEqual(wifi.leaves, 1)
    }

    func testCancelDuringScanPreventsLaterAssociation() {
        let wifi = Wifi()
        let join = MacHotspotAssociation { wifi }
        wifi.onScan = { join.cancel() }
        XCTAssertThrowsError(try join.associate(ssid: "glasses", password: "private")) {
            XCTAssertTrue($0 is CancellationError)
        }
        XCTAssertEqual(wifi.joins, 0)
    }

    func testCancelDuringBlockingAssociationWaitsForLateOwnedCleanup() throws {
        let wifi = Wifi()
        let join = MacHotspotAssociation { wifi }
        let started = expectation(description: "native association started")
        let cleaned = expectation(description: "late association cleaned up")
        let releaseNativeCall = DispatchSemaphore(value: 0)
        let ownership = HotspotNetworkOwnership()
        let token = try XCTUnwrap(ownership.acquire())
        wifi.beforeJoin = {
            started.fulfill()
            _ = releaseNativeCall.wait(timeout: .now() + 2)
        }
        DispatchQueue(label: "test.mac-wifi").async {
            do { _ = try join.associate(ssid: "glasses", password: "private"); XCTFail("Cancelled association succeeded") }
            catch { XCTAssertTrue(error is CancellationError) }
            do { try join.leave() } catch { XCTFail("Cleanup failed: \(error)") }
            ownership.release(token)
            cleaned.fulfill()
        }
        wait(for: [started], timeout: 1)
        join.cancel()
        XCTAssertNil(ownership.acquire(), "A timed-out writer must retain custody")
        releaseNativeCall.signal()
        wait(for: [cleaned], timeout: 1)
        XCTAssertEqual(wifi.leaves, 1)
        XCTAssertNotNil(ownership.acquire())
    }

    func testStaleReleaseCannotReleaseAnotherOwner() throws {
        let ownership = HotspotNetworkOwnership()
        let old = try XCTUnwrap(ownership.acquire())
        ownership.release(old)
        let current = try XCTUnwrap(ownership.acquire())
        ownership.release(old)
        XCTAssertNil(ownership.acquire())
        ownership.release(current)
        XCTAssertNotNil(ownership.acquire())
    }
}
