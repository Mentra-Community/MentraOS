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
        var releasesNetwork = true
        var missingScans = 0
        var scanError: Error?
        var associationError: Error?
        func name() throws -> String {
            "en1"
        }

        func currentSSID() throws -> String? {
            if unreadable { throw LocalMediaError("Location authorization was revoked") }
            return ssid
        }

        func network(ssid _: String) throws -> NSObject? {
            scans += 1; onScan?()
            if let scanError { throw scanError }
            return scans <= missingScans ? nil : NSObject()
        }

        func associate(network _: NSObject, password _: String) throws {
            joins += 1; beforeJoin?()
            if let associationError { throw associationError }
            ssid = "glasses"
        }

        func disassociate() {
            leaves += 1
            if releasesNetwork { ssid = nil }
        }
    }

    func testAutomaticJoinUsesActualWifiInterfaceAndCleansOwnedAssociation() throws {
        let wifi = Wifi()
        let join = MacHotspotAssociation(makeInterface: { wifi })
        XCTAssertEqual(try join.associate(ssid: "glasses", password: "private"), "en1")
        XCTAssertEqual(wifi.scans, 1)
        XCTAssertEqual(wifi.joins, 1)
        try join.leave()
        XCTAssertEqual(wifi.leaves, 1)
    }

    func testExistingUserAssociationIsReusedWithoutOwningItsRelease() throws {
        let wifi = Wifi(); wifi.ssid = "glasses"
        let join = MacHotspotAssociation(makeInterface: { wifi })
        _ = try join.associate(ssid: "glasses", password: "private")
        try join.leave()
        XCTAssertEqual(wifi.joins, 0)
        XCTAssertEqual(wifi.leaves, 0)
    }

    func testUserReplacementConnectionIsNotDisconnected() throws {
        let wifi = Wifi()
        let join = MacHotspotAssociation(makeInterface: { wifi })
        _ = try join.associate(ssid: "glasses", password: "private")
        wifi.ssid = "user-network"
        try join.leave()
        XCTAssertEqual(wifi.leaves, 0)
        XCTAssertEqual(wifi.ssid, "user-network")
    }

    func testAlreadyDisconnectedNetworkDoesNotBlockRelease() throws {
        let wifi = Wifi()
        let join = MacHotspotAssociation(makeInterface: { wifi })
        _ = try join.associate(ssid: "glasses", password: "private")
        wifi.ssid = nil
        try join.leave()
        XCTAssertEqual(wifi.leaves, 0)
    }

    func testUnreadableCurrentNetworkRetainsCleanupForRetry() throws {
        let wifi = Wifi()
        let join = MacHotspotAssociation(makeInterface: { wifi })
        _ = try join.associate(ssid: "glasses", password: "private")
        wifi.unreadable = true
        XCTAssertThrowsError(try join.leave())
        XCTAssertEqual(wifi.leaves, 0)
        wifi.unreadable = false
        try join.leave()
        XCTAssertEqual(wifi.leaves, 1)
    }

    func testUnfinishedDisassociationRejectsAndCanBeRetried() throws {
        let wifi = Wifi()
        let join = MacHotspotAssociation(makeInterface: { wifi })
        _ = try join.associate(ssid: "glasses", password: "private")
        wifi.releasesNetwork = false
        XCTAssertThrowsError(try join.leave())
        wifi.releasesNetwork = true
        try join.leave()
        XCTAssertEqual(wifi.leaves, 2)
    }

    func testCancelDuringScanPreventsLaterAssociation() {
        let wifi = Wifi()
        let join = MacHotspotAssociation(makeInterface: { wifi })
        wifi.onScan = { join.cancel() }
        XCTAssertThrowsError(try join.associate(ssid: "glasses", password: "private")) {
            XCTAssertTrue($0 is CancellationError)
        }
        XCTAssertEqual(wifi.joins, 0)
    }

    func testEmptyScansWaitForExactNetworkWithinTheSameDeadline() throws {
        let wifi = Wifi(); wifi.missingScans = 2
        var now: TimeInterval = 0
        let join = MacHotspotAssociation(deadline: 5, now: { now }, pause: { now += $0 }, makeInterface: { wifi })
        XCTAssertEqual(try join.associate(ssid: "glasses", password: "private"), "en1")
        XCTAssertEqual(wifi.scans, 3)
        XCTAssertEqual(wifi.joins, 1)
        XCTAssertEqual(now, 2)
        try join.leave()
        XCTAssertEqual(wifi.leaves, 1)
    }

    func testAbsentHotspotStopsAtOriginalDeadlineWithoutAssociating() {
        let wifi = Wifi(); wifi.missingScans = .max
        var now: TimeInterval = 3 // Authorization already used three of the five seconds.
        let join = MacHotspotAssociation(deadline: 5, now: { now }, pause: { now += $0 }, makeInterface: { wifi })
        XCTAssertThrowsError(try join.associate(ssid: "glasses", password: "private")) {
            XCTAssertTrue($0.localizedDescription.contains("hotspot join timed out"))
        }
        XCTAssertEqual(now, 5)
        XCTAssertEqual(wifi.scans, 2)
        XCTAssertEqual(wifi.joins, 0)
    }

    func testNativeScanFailureIsTerminalWithoutRetry() {
        let wifi = Wifi(); wifi.scanError = NSError(domain: "com.apple.wifi", code: 7)
        var pauses = 0
        let join = MacHotspotAssociation(pause: { _ in pauses += 1 }, makeInterface: { wifi })
        XCTAssertThrowsError(try join.associate(ssid: "glasses", password: "private")) {
            XCTAssertEqual(($0 as NSError).code, 7)
        }
        XCTAssertEqual(wifi.scans, 1)
        XCTAssertEqual(pauses, 0)
        XCTAssertEqual(wifi.joins, 0)
    }

    func testPermissionLossAfterScanIsTerminalWithoutRetry() {
        let wifi = Wifi(); wifi.missingScans = .max
        wifi.onScan = { wifi.unreadable = true }
        var pauses = 0
        let join = MacHotspotAssociation(pause: { _ in pauses += 1 }, makeInterface: { wifi })
        XCTAssertThrowsError(try join.associate(ssid: "glasses", password: "private"))
        XCTAssertEqual(wifi.scans, 1)
        XCTAssertEqual(pauses, 0)
        XCTAssertEqual(wifi.joins, 0)
    }

    func testNetworkReturnedAfterDeadlineCannotStartAssociation() {
        let wifi = Wifi()
        var now: TimeInterval = 0
        wifi.onScan = { now = 5 }
        let join = MacHotspotAssociation(deadline: 5, now: { now }, makeInterface: { wifi })
        XCTAssertThrowsError(try join.associate(ssid: "glasses", password: "private"))
        XCTAssertEqual(wifi.scans, 1)
        XCTAssertEqual(wifi.joins, 0)
    }

    func testCancelBetweenEmptyScansPreventsAnotherScanOrAssociation() {
        let wifi = Wifi(); wifi.missingScans = .max
        var join: MacHotspotAssociation!
        join = MacHotspotAssociation(pause: { _ in join.cancel() }, makeInterface: { wifi })
        XCTAssertThrowsError(try join.associate(ssid: "glasses", password: "private")) {
            XCTAssertTrue($0 is CancellationError)
        }
        XCTAssertEqual(wifi.scans, 1)
        XCTAssertEqual(wifi.joins, 0)
    }

    func testAssociationFailureIsTerminalWithoutAnotherScanOrJoin() {
        let wifi = Wifi(); wifi.associationError = NSError(domain: "com.apple.wifi", code: 9)
        let join = MacHotspotAssociation(makeInterface: { wifi })
        XCTAssertThrowsError(try join.associate(ssid: "glasses", password: "private")) {
            XCTAssertEqual(($0 as NSError).code, 9)
        }
        XCTAssertEqual(wifi.scans, 1)
        XCTAssertEqual(wifi.joins, 1)
    }

    func testCancellationWakesEmptyScanPacingAndSettlesBeforeCustodyRelease() throws {
        let wifi = Wifi(); wifi.missingScans = .max
        let scanned = expectation(description: "first empty scan completed")
        let stopped = expectation(description: "cancelled discovery settled")
        wifi.onScan = { if wifi.scans == 1 { scanned.fulfill() } }
        let join = MacHotspotAssociation(makeInterface: { wifi })
        let ownership = HotspotNetworkOwnership()
        let token = try XCTUnwrap(ownership.acquire())
        DispatchQueue(label: "test.mac-wifi-empty").async {
            do { _ = try join.associate(ssid: "glasses", password: "private"); XCTFail("Cancelled discovery succeeded") }
            catch { XCTAssertTrue(error is CancellationError) }
            do { try join.leave() } catch { XCTFail("Cleanup failed: \(error)") }
            ownership.release(token)
            stopped.fulfill()
        }
        wait(for: [scanned], timeout: 1)
        XCTAssertNil(ownership.acquire())
        join.cancel()
        wait(for: [stopped], timeout: 0.5)
        XCTAssertEqual(wifi.scans, 1)
        XCTAssertEqual(wifi.joins, 0)
        XCTAssertEqual(wifi.leaves, 0)
        XCTAssertNotNil(ownership.acquire())
    }

    func testCancelDuringBlockingAssociationWaitsForLateOwnedCleanup() throws {
        let wifi = Wifi()
        let join = MacHotspotAssociation(makeInterface: { wifi })
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
