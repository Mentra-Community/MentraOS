@testable import GlassesMediaCore
import XCTest

final class MacHotspotJoinDiagnosticsTests: XCTestCase {
    private func facts(_ message: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any])
    }

    func testTimeoutPreservesPendingAuthorizationThroughLateCallbacks() throws {
        var messages: [String] = []
        let diagnostics = MacHotspotJoinDiagnostics(generation: 7) { messages.append($0) }
        diagnostics.authorizationStatus(0, requested: true)
        let failure = HotspotJoinFailure(diagnostics.timeout())
        XCTAssertEqual(failure.code, "ERR_HOTSPOT_JOIN")
        XCTAssertEqual(failure.message, "Mac hotspot join timed out (stage=location_authorization, authorization=0)")
        diagnostics.begin(.association)
        diagnostics.authorizationStatus(3)
        let timeout = try facts(messages[1])
        XCTAssertEqual(timeout["late"] as? Bool, false)
        let late = try facts(try XCTUnwrap(messages.last))
        XCTAssertEqual(late["stage"] as? String, "location_authorization")
        XCTAssertEqual(late["authorization"] as? Int, 0)
        XCTAssertEqual(late["late"] as? Bool, true)
    }

    func testInitialAndChangedAuthorizationAreDistinguished() throws {
        var messages: [String] = []
        let diagnostics = MacHotspotJoinDiagnostics(generation: 1) { messages.append($0) }
        diagnostics.authorizationStatus(0, initial: true)
        diagnostics.authorizationStatus(3)
        XCTAssertEqual(try facts(messages[0])["event"] as? String, "authorization_initial")
        XCTAssertEqual(try facts(messages[1])["event"] as? String, "authorization_change")
        XCTAssertEqual(try facts(messages[1])["authorization"] as? Int, 3)
    }

    func testNativeFailureKeepsCodesWithoutUserInfoOrNetworkSecrets() throws {
        var messages: [String] = []
        let diagnostics = MacHotspotJoinDiagnostics(generation: 8) { messages.append($0) }
        diagnostics.begin(.scan)
        let underlying = NSError(domain: "NSPOSIXErrorDomain", code: 13,
                                 userInfo: [NSLocalizedDescriptionKey: "private-passphrase"])
        let native = NSError(domain: "com.apple.wifi", code: -3905,
                             userInfo: [NSUnderlyingErrorKey: underlying,
                                        "SSID": "private-network", "password": "private-passphrase"])
        diagnostics.result(error: native, interface: "private network name")
        let result = try facts(try XCTUnwrap(messages.last))
        XCTAssertEqual(result["stage"] as? String, "scan")
        XCTAssertEqual(result["domain"] as? String, "com.apple.wifi")
        XCTAssertEqual(result["code"] as? Int, -3905)
        XCTAssertEqual(result["underlying_domain"] as? String, "NSPOSIXErrorDomain")
        XCTAssertEqual(result["underlying_code"] as? Int, 13)
        XCTAssertNil(result["interface"])
        XCTAssertFalse(messages.joined().contains("private-"))
        XCTAssertFalse(messages.joined().contains("password"))
    }

    func testSeparateJoinsDoNotInheritTimedOutStages() throws {
        var messages: [String] = []
        let old = MacHotspotJoinDiagnostics(generation: 1) { messages.append($0) }
        old.begin(.scan)
        _ = old.timeout()
        let next = MacHotspotJoinDiagnostics(generation: 2) { messages.append($0) }
        next.begin(.address)
        next.result(interface: "en1")
        let result = try facts(try XCTUnwrap(messages.last))
        XCTAssertEqual(result["generation"] as? Int, 2)
        XCTAssertEqual(result["stage"] as? String, "address_verification")
        XCTAssertEqual(result["interface"] as? String, "en1")
        XCTAssertEqual(result["late"] as? Bool, false)
    }
}
