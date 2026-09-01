@testable import MentraBluetoothSDK
import XCTest

final class WifiRequestResolutionTests: XCTestCase {
    @MainActor
    func testPendingResponseCancellationResumesExactlyOnceWithoutTimeout() async {
        let pending = PendingResponse<Int>(operation: "WiFi capability negotiation")
        let waiter = Task { @MainActor in
            try await pending.wait(timeoutMs: nil)
        }
        await Task.yield()

        waiter.cancel()

        do {
            _ = try await waiter.value
            XCTFail("Expected cancellation")
        } catch let error as BluetoothSdkError {
            XCTAssertEqual(error.code, "request_cancelled")
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
        pending.resolve(42)
        do {
            _ = try await pending.wait(timeoutMs: nil)
            XCTFail("Late resolve must not replace the cancellation result")
        } catch let error as BluetoothSdkError {
            XCTAssertEqual(error.code, "request_cancelled")
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testCapabilitiesAreUnknownPerSessionUntilVersionInfoFinalizesThem() {
        let capabilities = WifiSessionCapabilities()
        capabilities.reset(sessionId: "sid-1")

        XCTAssertEqual(capabilities.forgetResult, .unknown)
        XCTAssertEqual(capabilities.savedNetworks, .unknown)
        capabilities.applyVersionInfo1(["sid": "sid-1", "wifiForgetResultVersion": 1])

        XCTAssertEqual(capabilities.forgetResult, .supported(version: 1))
        XCTAssertEqual(capabilities.savedNetworks, .unsupported)
        XCTAssertEqual(capabilities.forgetMode(), .modern)
        XCTAssertEqual(capabilities.savedNetworksMode(), .legacy)
    }

    func testNewSessionResetsCapabilitiesAndAdvancesEpoch() {
        let capabilities = WifiSessionCapabilities()
        capabilities.reset(sessionId: "sid-1")
        capabilities.applyVersionInfo1([
            "wifiForgetResultVersion": 1,
            "savedWifiNetworksVersion": 1,
        ])
        let oldEpoch = capabilities.epoch

        capabilities.reset(sessionId: "sid-2")

        XCTAssertGreaterThan(capabilities.epoch, oldEpoch)
        XCTAssertEqual(capabilities.sessionId, "sid-2")
        XCTAssertEqual(capabilities.forgetResult, .unknown)
        XCTAssertEqual(capabilities.savedNetworks, .unknown)
    }

    func testSsidValidationRejectsBlankInputWithoutChangingIdentity() {
        XCTAssertFalse(wifiSsidIsValid("   "))
        XCTAssertTrue(wifiSsidIsValid(" Field AP "))
    }

    func testForgetResultRequiresExactIdSessionSsidAndProtocol() {
        let exact: [String: Any] = [
            "requestId": "forget-1",
            "sid": "sid-1",
            "ssid": " Field AP ",
            "protocolVersion": 1,
            "outcome": "dispatched",
            "connected": false,
        ]

        XCTAssertNil(parseWifiForgetResult(
            expectedRequestId: "other", expectedSid: "sid-1", expectedSsid: " Field AP ",
            capabilityVersion: 1, data: exact
        ))
        XCTAssertNil(parseWifiForgetResult(
            expectedRequestId: "forget-1", expectedSid: "sid-1", expectedSsid: " Field AP ",
            capabilityVersion: 1, data: exact.filter { $0.key != "requestId" }
        ))
        XCTAssertNil(parseWifiForgetResult(
            expectedRequestId: "forget-1", expectedSid: "other", expectedSsid: " Field AP ",
            capabilityVersion: 1, data: exact
        ))
        XCTAssertNil(parseWifiForgetResult(
            expectedRequestId: "forget-1", expectedSid: "sid-1", expectedSsid: "Field AP",
            capabilityVersion: 1, data: exact
        ))
        XCTAssertNil(parseWifiForgetResult(
            expectedRequestId: "forget-1", expectedSid: "sid-1", expectedSsid: " Field AP ",
            capabilityVersion: 2, data: exact
        ))
        XCTAssertEqual(
            parseWifiForgetResult(
                expectedRequestId: "forget-1", expectedSid: "sid-1", expectedSsid: " Field AP ",
                capabilityVersion: 1, data: exact
            )?.outcome,
            .dispatched
        )
    }

    func testForgetParserPreservesEveryHonestTerminalOutcome() {
        for outcome in ["confirmed", "dispatched", "not_found", "unsupported", "failed"] {
            let parsed = parseWifiForgetResult(
                expectedRequestId: "forget-1",
                expectedSid: "sid-1",
                expectedSsid: "AP",
                capabilityVersion: 1,
                data: [
                    "requestId": "forget-1",
                    "sid": "sid-1",
                    "ssid": "AP",
                    "protocolVersion": 1,
                    "outcome": outcome,
                ]
            )
            XCTAssertEqual(parsed?.outcome.rawValue, outcome)
        }
    }

    func testMissingConnectivitySnapshotRemainsUnknown() {
        let parsed = parseWifiForgetResult(
            expectedRequestId: "forget-1",
            expectedSid: "sid-1",
            expectedSsid: "AP",
            capabilityVersion: 1,
            data: [
                "requestId": "forget-1",
                "sid": "sid-1",
                "ssid": "AP",
                "protocolVersion": 1,
                "outcome": "dispatched",
            ]
        )

        XCTAssertNil(parsed?.connected)
        XCTAssertNil(parsed?.values["connected"])
    }

    func testLegacyForgetIsExplicitlyUnverified() {
        let result = legacyWifiForgetResult(
            requestId: "forget-1",
            sid: "sid-legacy",
            ssid: "AP",
            event: WifiStatusEvent(connected: false, ssid: nil, localIp: nil)
        )

        XCTAssertEqual(result.mode, "legacy")
        XCTAssertEqual(result.outcome, .legacyUnverified)
    }

    func testSavedListPreservesIdentityAndRequiresCorrelationTuple() {
        let exact: [String: Any] = [
            "requestId": "saved-1",
            "sid": "sid-1",
            "protocolVersion": 1,
            "outcome": "confirmed",
            "networks": [" Field AP ", "", "Field AP", " Field AP "],
        ]

        XCTAssertNil(parseSavedWifiNetworks(
            expectedRequestId: "other", expectedSid: "sid-1", capabilityVersion: 1, data: exact
        ))
        XCTAssertNil(parseSavedWifiNetworks(
            expectedRequestId: "saved-1", expectedSid: "sid-1", capabilityVersion: 1,
            data: exact.filter { $0.key != "requestId" }
        ))
        XCTAssertNil(parseSavedWifiNetworks(
            expectedRequestId: "saved-1", expectedSid: "other", capabilityVersion: 1, data: exact
        ))
        XCTAssertNil(parseSavedWifiNetworks(
            expectedRequestId: "saved-1", expectedSid: "sid-1", capabilityVersion: 2, data: exact
        ))
        XCTAssertEqual(
            parseSavedWifiNetworks(
                expectedRequestId: "saved-1", expectedSid: "sid-1", capabilityVersion: 1, data: exact
            )?.networks,
            [" Field AP ", "Field AP"]
        )

        var failure = exact
        failure["outcome"] = "failed"
        failure["error"] = "backend_failed"
        let parsedFailure = parseSavedWifiNetworks(
            expectedRequestId: "saved-1",
            expectedSid: "sid-1",
            capabilityVersion: 1,
            data: failure
        )
        XCTAssertEqual(parsedFailure?.outcome, .failed)
        XCTAssertEqual(parsedFailure?.error, "backend_failed")
    }

    func testDelayedCallbacksRequireSameRequestAndSessionEpoch() {
        XCTAssertTrue(wifiDelayedCallbackApplies(
            expectedEpoch: 7, currentEpoch: 7, isCurrentRequest: true
        ))
        XCTAssertFalse(wifiDelayedCallbackApplies(
            expectedEpoch: 7, currentEpoch: 8, isCurrentRequest: true
        ))
        XCTAssertFalse(wifiDelayedCallbackApplies(
            expectedEpoch: 7, currentEpoch: 7, isCurrentRequest: false
        ))
    }

    func testUnknownCapabilityHasBoundedDiscoveryDeadlineWithoutSelectingLegacy() {
        XCTAssertTrue(wifiCapabilityDiscoveryDeadlineRequired(.discovering))
        XCTAssertFalse(wifiCapabilityDiscoveryDeadlineRequired(.modern))
        XCTAssertFalse(wifiCapabilityDiscoveryDeadlineRequired(.legacy))
        XCTAssertEqual(wifiCapabilityNegotiationTimeoutCode, "capability_negotiation_timeout")
    }

    func testRawForgetEventPreservesModernAndLegacyWireTruth() {
        let modern = normalizeWifiForgetResultEvent(
            requestId: "forget-1",
            sid: "sid-1",
            ssid: "AP",
            protocolVersion: 1,
            outcome: "dispatched",
            legacyDispatched: nil,
            connected: false,
            currentSsid: "",
            localIp: "",
            error: nil
        )
        let legacy = normalizeWifiForgetResultEvent(
            requestId: "forget-old",
            sid: "",
            ssid: "AP",
            protocolVersion: 0,
            outcome: "",
            legacyDispatched: true,
            connected: false,
            currentSsid: "",
            localIp: "",
            error: nil
        )
        let withoutSnapshot = normalizeWifiForgetResultEvent(
            requestId: "forget-unknown",
            sid: "sid-1",
            ssid: "AP",
            protocolVersion: 1,
            outcome: "dispatched",
            legacyDispatched: nil,
            connected: nil,
            currentSsid: "",
            localIp: "",
            error: nil
        )

        XCTAssertEqual(modern?["mode"] as? String, "modern")
        XCTAssertEqual(modern?["outcome"] as? String, "dispatched")
        XCTAssertEqual(legacy?["mode"] as? String, "legacy")
        XCTAssertEqual(legacy?["dispatched"] as? Bool, true)
        XCTAssertNil(legacy?["sid"])
        XCTAssertNil(withoutSnapshot?["connected"])
        XCTAssertNil(normalizeWifiForgetResultEvent(
            requestId: "bad",
            sid: "",
            ssid: "AP",
            protocolVersion: 0,
            outcome: "",
            legacyDispatched: nil,
            connected: false,
            currentSsid: "",
            localIp: "",
            error: nil
        ))
    }
}
