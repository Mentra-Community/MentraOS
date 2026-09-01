@testable import MentraBluetoothSDK
import XCTest

final class WifiRequestResolutionTests: XCTestCase {
    func testSsidValidationRejectsBlankInputWithoutChangingIdentity() {
        XCTAssertFalse(wifiSsidIsValid("   "))
        XCTAssertTrue(wifiSsidIsValid(" Field AP "))
    }

    func testForgetResultRequiresExactRequestId() {
        let base: [String: Any] = ["ssid": " Field AP ", "dispatched": true]

        XCTAssertNil(parseWifiForgetResult(expectedRequestId: "forget-1", expectedSsid: " Field AP ", data: base))
        XCTAssertNil(
            parseWifiForgetResult(
                expectedRequestId: "forget-1",
                expectedSsid: " Field AP ",
                data: base.merging(["requestId": "forget-other"]) { _, new in new }
            )
        )
        guard case .dispatched? = parseWifiForgetResult(
            expectedRequestId: "forget-1",
            expectedSsid: " Field AP ",
            data: base.merging(["requestId": "forget-1"]) { _, new in new }
        ) else {
            return XCTFail("Expected exact request id to match")
        }
    }

    func testCorrelatedFailureRemainsTerminalDuringLegacyPriorityWindow() {
        XCTAssertGreaterThan(wifiForgetLegacyFallbackDelayMs(priorityDeadlineMs: 1750, nowMs: 1000), 0)
        let result = parseWifiForgetResult(
            expectedRequestId: "forget-1",
            expectedSsid: "Field AP",
            data: [
                "requestId": "forget-1",
                "ssid": "Field AP",
                "dispatched": false,
                "error": "forget_dispatch_failed",
            ]
        )

        guard case let .failure(error)? = result else {
            return XCTFail("Expected correlated failure")
        }
        XCTAssertEqual(error, "forget_dispatch_failed")
    }

    func testLegacyFallbackWaitsOnlyForBoundedCorrelatedPriorityWindow() {
        XCTAssertEqual(wifiForgetLegacyFallbackDelayMs(priorityDeadlineMs: 1750, nowMs: 1000), 750)
        XCTAssertEqual(wifiForgetLegacyFallbackDelayMs(priorityDeadlineMs: 1750, nowMs: 1750), 0)
        XCTAssertEqual(wifiForgetLegacyFallbackDelayMs(priorityDeadlineMs: 1750, nowMs: 2000), 0)
    }

    func testDelayedFallbackIsNoOpAfterTimeoutOrReplacement() {
        XCTAssertTrue(wifiForgetFallbackStillApplies(scheduledRequestId: "forget-1", activeRequestId: "forget-1"))
        XCTAssertFalse(wifiForgetFallbackStillApplies(scheduledRequestId: "forget-1", activeRequestId: nil))
        XCTAssertFalse(wifiForgetFallbackStillApplies(scheduledRequestId: "forget-1", activeRequestId: "forget-2"))
    }

    func testSavedListPreservesExactSsidIdentity() {
        let result = parseSavedWifiNetworks(
            expectedRequestId: "saved-1",
            data: [
                "requestId": "saved-1",
                "networks": [" Field AP ", "", "Field AP", " Field AP "],
            ]
        )

        XCTAssertEqual(result, ParsedSavedWifiNetworks(networks: [" Field AP ", "Field AP"], error: nil))
    }

    func testSavedListRejectsWrongIdAndParsesTerminalError() {
        XCTAssertNil(
            parseSavedWifiNetworks(
                expectedRequestId: "saved-1",
                data: ["requestId": "saved-other", "networks": []]
            )
        )
        XCTAssertEqual(
            parseSavedWifiNetworks(
                expectedRequestId: "saved-1",
                data: [
                    "requestId": "saved-1",
                    "networks": [],
                    "error": "list_saved_networks_unsupported",
                ]
            )?.error,
            "list_saved_networks_unsupported"
        )
    }
}
