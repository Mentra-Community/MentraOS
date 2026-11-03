import CoreLocation
@testable import GlassesMediaCore
import XCTest

final class MacHotspotAuthorizationFactsTests: XCTestCase {
    func testStaticRejectionRetainsMeasuredInstanceStatusWithoutInventingCallback() {
        let facts = MacHotspotAuthorizationFacts()
        facts.observeInstance(raw: CLAuthorizationStatus.authorizedAlways.rawValue, getter: .instanceInitial, foreground: .active)
        let failure = HotspotJoinFailure(facts.failure("Location access is required to verify the current Mac Wi-Fi network",
                                                       raw: CLAuthorizationStatus.notDetermined.rawValue, getter: .staticSSID, foreground: .unknown))
        XCTAssertEqual(failure.code, "ERR_HOTSPOT_JOIN")
        XCTAssertTrue(failure.message.contains("raw=0 getter=static-ssid foreground=unknown"))
        XCTAssertTrue(failure.message.contains("instanceRaw=3 instanceGetter=instance-initial instanceForeground=active"))
        XCTAssertTrue(failure.message.contains("initialCallbackObserved=false"))
        XCTAssertTrue(failure.message.contains("pid=\(ProcessInfo.processInfo.processIdentifier)"))
        XCTAssertLessThanOrEqual(failure.message.utf8.count, 512)
    }

    func testActualCallbackAndLaterDeniedStatusRemainDistinct() {
        let facts = MacHotspotAuthorizationFacts()
        facts.observeInstance(raw: CLAuthorizationStatus.notDetermined.rawValue, getter: .instanceInitial, foreground: .inactive)
        facts.observeInstance(raw: CLAuthorizationStatus.authorizedAlways.rawValue, getter: .instanceCallback, foreground: .active)
        let failure = facts.failure("Location access is required to verify the current Mac Wi-Fi network",
                                    raw: CLAuthorizationStatus.denied.rawValue, getter: .staticSSID, foreground: .unknown)
        XCTAssertTrue(failure.message.contains("raw=2 getter=static-ssid"))
        XCTAssertTrue(failure.message.contains("instanceRaw=3 instanceGetter=instance-callback"))
        XCTAssertTrue(failure.message.contains("initialCallbackObserved=true"))
        XCTAssertFalse(MacHotspotAuthorization.isAuthorized(.denied))
        XCTAssertFalse(MacHotspotAuthorization.isAuthorized(.restricted))
        XCTAssertFalse(MacHotspotAuthorization.isAuthorized(.notDetermined))
    }

    func testAnIndependentSSIDReadHasNoInventedPriorAuthorization() {
        let facts = MacHotspotAuthorizationFacts()
        let failure = facts.failure("Location access is required to verify the current Mac Wi-Fi network",
                                    raw: CLAuthorizationStatus.restricted.rawValue, getter: .staticSSID, foreground: .unknown)
        XCTAssertTrue(failure.message.contains("instanceRaw=unknown instanceGetter=unknown instanceForeground=unknown"))
        XCTAssertTrue(failure.message.contains("initialCallbackObserved=false"))
    }

    func testFailureFactsCannotOverrideCancellationOrIncludeNativeUserInfo() {
        let facts = MacHotspotAuthorizationFacts()
        facts.observeInstance(raw: 3, getter: .instanceCallback, foreground: .active)
        let cancelled = HotspotJoinFailure(CancellationError())
        XCTAssertEqual(cancelled.code, "ERR_HOTSPOT_CANCELLED")
        XCTAssertEqual(cancelled.message, "Hotspot join cancelled")
        XCTAssertFalse(cancelled.message.contains("location raw="))
        let native = HotspotJoinFailure(NSError(domain: "NSPOSIXErrorDomain", code: 61,
                                                userInfo: ["ssid": "secret-network", "password": "secret-password"]))
        XCTAssertFalse(native.message.contains("secret"))
        XCTAssertFalse(native.message.contains("location raw="))
    }

    func testForegroundReadOffOwningThreadStaysUnknown() {
        let observed = expectation(description: "worker observation")
        DispatchQueue.global().async {
            XCTAssertEqual(MacHotspotAuthorizationFacts.foreground(), .unknown)
            observed.fulfill()
        }
        wait(for: [observed], timeout: 2)
    }
}
