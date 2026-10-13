@testable import GlassesMediaCore
import XCTest

final class HotspotJoinFailureTests: XCTestCase {
    func testOwnedFailurePreservesCauseAndDistinctCancellation() {
        let failure = HotspotJoinFailure(LocalMediaError("Mac Wi-Fi scan failed (com.apple.wifi, -3905)"))
        XCTAssertEqual(failure.code, "ERR_HOTSPOT_JOIN")
        XCTAssertEqual(failure.message, "Mac Wi-Fi scan failed (com.apple.wifi, -3905)")
        let cancelled = HotspotJoinFailure(CancellationError())
        XCTAssertEqual(cancelled.code, "ERR_HOTSPOT_CANCELLED")
        XCTAssertEqual(cancelled.message, "Hotspot join cancelled")
        let leave = HotspotJoinFailure(LocalMediaError("Hotspot join cancelled"))
        XCTAssertEqual(leave.code, "ERR_HOTSPOT_CANCELLED")
        XCTAssertEqual(leave.message, "Hotspot join cancelled")
    }

    func testNativeFailureOmitsPrivateDescriptionAndUserInfo() {
        let failure = HotspotJoinFailure(NSError(domain: "NSPOSIXErrorDomain", code: 61,
            userInfo: [NSLocalizedDescriptionKey: "fixture confidential description", "networkName": "fixture confidential network"]))
        XCTAssertEqual(failure.code, "ERR_HOTSPOT_NATIVE")
        XCTAssertEqual(failure.message, "Hotspot join failed (NSPOSIXErrorDomain, 61)")
        XCTAssertFalse(failure.message.contains("fixture"))
        XCTAssertEqual(HotspotJoinFailure(NSError(domain: "private domain with spaces", code: 2)).message,
            "Hotspot join failed (unavailable, 2)")
    }

    func testOwnedMessagesAreBoundedAndSingleLine() {
        let failure = HotspotJoinFailure(LocalMediaError("\n\t" + String(repeating: "a", count: 600)))
        XCTAssertEqual(failure.message, String(repeating: "a", count: 512))
    }
}
