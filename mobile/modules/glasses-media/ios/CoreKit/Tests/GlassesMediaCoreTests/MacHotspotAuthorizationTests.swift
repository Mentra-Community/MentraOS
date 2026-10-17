import CoreLocation
@testable import GlassesMediaCore
import XCTest

final class MacHotspotAuthorizationTests: XCTestCase {
    private final class Manager: CLLocationManager {
        var status: CLAuthorizationStatus = .authorizedAlways
        var requests = 0
        override var authorizationStatus: CLAuthorizationStatus {
            XCTAssertTrue(Thread.isMainThread, "CLLocationManager belongs to the main thread")
            return status
        }

        override func requestWhenInUseAuthorization() {
            requests += 1
        }
    }

    private final class Wifi: MacWifiInterface {
        var ssid: String?
        var scans = 0
        var joins = 0
        var leaves = 0
        var onRead: (() -> Void)?
        var onScan: (() -> Void)?
        var onJoin: (() -> Void)?
        func name() throws -> String {
            "en0"
        }

        func currentSSID() throws -> String? {
            onRead?(); return ssid
        }

        func network(ssid _: String) throws -> NSObject? {
            scans += 1; onScan?(); return NSObject()
        }

        func associate(network _: NSObject, password _: String) throws {
            joins += 1; onJoin?(); ssid = "glasses"
        }

        func disassociate() {
            leaves += 1; ssid = nil
        }
    }

    private func started(_ manager: Manager) -> MacHotspotAuthorization {
        let authorization = MacHotspotAuthorization(makeManager: { manager }, locationServicesEnabled: { true })
        let ready = expectation(description: "initialized instance ready")
        authorization.start {
            if case let .failure(error) = $0 { XCTFail("Authorization failed: \(error)") }
            ready.fulfill()
        }
        wait(for: [ready], timeout: 2)
        return authorization
    }

    private func closed(_ authorization: MacHotspotAuthorization) {
        authorization.cancel()
        let closed = expectation(description: "owning thread closed")
        DispatchQueue.main.async { closed.fulfill() }
        wait(for: [closed], timeout: 2)
    }

    func testInitializedAlwaysInstanceRemainsAliveAcrossJoinAndCleanup() throws {
        let manager = Manager()
        let authorization = started(manager)
        XCTAssertNotNil(manager.delegate, "Success must not discard the initialized Location recipient")
        let wifi = Wifi()
        let association = MacHotspotAssociation(makeInterface: { wifi }, authorization: authorization)
        XCTAssertEqual(try association.associate(ssid: "glasses", password: "private"), "en0")
        XCTAssertEqual(wifi.scans, 1)
        XCTAssertEqual(wifi.joins, 1)
        authorization.cancelPending()
        let pendingCancelled = expectation(description: "cancel pending checked")
        DispatchQueue.main.async { pendingCancelled.fulfill() }
        wait(for: [pendingCancelled], timeout: 2)
        try association.leave()
        XCTAssertEqual(wifi.leaves, 1, "A cancelled join still owns its late association cleanup")
        closed(authorization)
        XCTAssertNil(manager.delegate)
        XCTAssertThrowsError(try authorization.requireCurrentAuthorization())
    }

    func testInstanceReadDoesNotReuseEarlierAlwaysGrant() {
        let manager = Manager()
        let authorization = started(manager)
        let wifi = Wifi()
        let association = MacHotspotAssociation(makeInterface: { wifi }, authorization: authorization)
        manager.status = .notDetermined
        XCTAssertThrowsError(try association.associate(ssid: "glasses", password: "private")) {
            XCTAssertTrue(HotspotJoinFailure($0).message.contains("raw=0 getter=instance-current"))
        }
        XCTAssertEqual(wifi.scans, 0)
        XCTAssertEqual(wifi.joins, 0)
        closed(authorization)
    }

    func testWorkerChecksCurrentRecipientOnOwningThread() {
        let manager = Manager()
        let authorization = started(manager)
        let read = expectation(description: "worker current recipient read")
        DispatchQueue.global().async {
            do { try authorization.requireCurrentAuthorization() }
            catch { XCTFail("Current authorized recipient rejected: \(error)") }
            read.fulfill()
        }
        wait(for: [read], timeout: 2)
        closed(authorization)
    }

    func testRecordedStaticNotDeterminedDoesNotReplaceCurrentInitializedAlwaysRecipient() throws {
        let manager = Manager()
        let facts = MacHotspotAuthorizationFacts()
        let authorization = MacHotspotAuthorization(facts: facts, makeManager: { manager }, locationServicesEnabled: { true })
        let ready = expectation(description: "same recipient ready")
        authorization.start {
            if case let .failure(error) = $0 { XCTFail("Authorization failed: \(error)") }
            ready.fulfill()
        }
        wait(for: [ready], timeout: 2)
        let oldStaticError = facts.failure("Location access is required to verify the current Mac Wi-Fi network",
                                           raw: CLAuthorizationStatus.notDetermined.rawValue, getter: .staticSSID, foreground: .unknown)
        XCTAssertTrue(oldStaticError.message.contains("raw=0 getter=static-ssid"))
        XCTAssertTrue(oldStaticError.message.contains("instanceRaw=3 instanceGetter=instance-initial"))
        let wifi = Wifi()
        let association = MacHotspotAssociation(makeInterface: { wifi }, authorization: authorization)
        XCTAssertEqual(try association.associate(ssid: "glasses", password: "private"), "en0")
        try association.leave()
        closed(authorization)
    }

    func testRevocationDuringScanPreventsAssociation() {
        let manager = Manager()
        let authorization = started(manager)
        let wifi = Wifi()
        wifi.onScan = { manager.status = .denied }
        let association = MacHotspotAssociation(makeInterface: { wifi }, authorization: authorization)
        XCTAssertThrowsError(try association.associate(ssid: "glasses", password: "private"))
        XCTAssertEqual(wifi.scans, 1)
        XCTAssertEqual(wifi.joins, 0)
        closed(authorization)
    }

    func testDisabledLocationServicesRejectsAlwaysGrantBeforeSSIDRead() {
        let manager = Manager()
        let authorization = MacHotspotAuthorization(makeManager: { manager }, locationServicesEnabled: { false })
        let ready = expectation(description: "initial recipient status")
        authorization.start { _ in ready.fulfill() }
        wait(for: [ready], timeout: 2)
        let wifi = Wifi()
        var reads = 0
        wifi.onRead = { reads += 1 }
        let association = MacHotspotAssociation(makeInterface: { wifi }, authorization: authorization)
        XCTAssertThrowsError(try association.associate(ssid: "glasses", password: "private")) {
            XCTAssertTrue(HotspotJoinFailure($0).message.contains("Location services are required"))
        }
        XCTAssertEqual(reads, 0)
        XCTAssertEqual(wifi.scans, 0)
        XCTAssertEqual(wifi.joins, 0)
        closed(authorization)
    }

    func testPermissionLossAfterSSIDReadPreventsScan() {
        let manager = Manager()
        let authorization = started(manager)
        let wifi = Wifi()
        wifi.onRead = { manager.status = .restricted }
        let association = MacHotspotAssociation(makeInterface: { wifi }, authorization: authorization)
        XCTAssertThrowsError(try association.associate(ssid: "glasses", password: "private"))
        XCTAssertEqual(wifi.scans, 0)
        XCTAssertEqual(wifi.joins, 0)
        closed(authorization)
    }

    func testActualCallbackRevocationNotifiesSessionOnce() {
        let manager = Manager()
        let authorization = started(manager)
        var revocations = 0
        authorization.onRevoked = { error in
            XCTAssertTrue(HotspotJoinFailure(error).message.contains("getter=instance-callback"))
            revocations += 1
        }
        manager.status = .denied
        authorization.locationManagerDidChangeAuthorization(manager)
        authorization.locationManagerDidChangeAuthorization(manager)
        XCTAssertEqual(revocations, 1)
        XCTAssertThrowsError(try authorization.requireCurrentAuthorization())
        closed(authorization)
    }

    func testRevocationAfterLateAssociationRetainsOwnedCleanupUntilPermissionReturns() throws {
        let manager = Manager()
        let authorization = started(manager)
        let wifi = Wifi()
        wifi.onJoin = { manager.status = .denied }
        let association = MacHotspotAssociation(makeInterface: { wifi }, authorization: authorization)
        XCTAssertThrowsError(try association.associate(ssid: "glasses", password: "private"))
        XCTAssertEqual(wifi.joins, 1)
        XCTAssertThrowsError(try association.leave())
        XCTAssertEqual(wifi.leaves, 0, "Unknown membership must not disconnect a replacement network")
        manager.status = .authorizedAlways
        try association.leave()
        XCTAssertEqual(wifi.leaves, 1)
        closed(authorization)
    }

    func testCancelWhileInitialCallbackIsHeldSettlesOnceAndIgnoresLateGrant() {
        let manager = Manager(); manager.status = .notDetermined
        let authorization = MacHotspotAuthorization(makeManager: { manager }, locationServicesEnabled: { true })
        let installed = expectation(description: "initial pending read")
        let cancelled = expectation(description: "cancelled reply")
        var replies = 0
        authorization.start {
            replies += 1
            if case let .failure(error) = $0 { XCTAssertTrue(error is CancellationError) }
            else { XCTFail("Cancelled pending authorization succeeded") }
            cancelled.fulfill()
        }
        DispatchQueue.main.async { installed.fulfill() }
        wait(for: [installed], timeout: 2)
        XCTAssertEqual(manager.requests, 1)
        authorization.cancelPending()
        wait(for: [cancelled], timeout: 2)
        manager.status = .authorizedAlways
        authorization.locationManagerDidChangeAuthorization(manager)
        XCTAssertEqual(replies, 1)
        XCTAssertNil(manager.delegate)
        XCTAssertThrowsError(try authorization.requireCurrentAuthorization())
    }

    func testPendingCallbackGrantKeepsRecipientAndRecordsActualCallback() throws {
        let manager = Manager(); manager.status = .notDetermined
        let facts = MacHotspotAuthorizationFacts()
        let authorization = MacHotspotAuthorization(facts: facts, makeManager: { manager }, locationServicesEnabled: { true })
        let ready = expectation(description: "callback grant")
        authorization.start {
            if case let .failure(error) = $0 { XCTFail("Callback grant failed: \(error)") }
            ready.fulfill()
        }
        DispatchQueue.main.async {
            manager.status = .authorizedAlways
            authorization.locationManagerDidChangeAuthorization(manager)
        }
        wait(for: [ready], timeout: 2)
        XCTAssertNotNil(manager.delegate)
        manager.status = .denied
        XCTAssertThrowsError(try authorization.requireCurrentAuthorization()) {
            XCTAssertTrue(HotspotJoinFailure($0).message.contains("initialCallbackObserved=true"))
        }
        closed(authorization)
    }
}
