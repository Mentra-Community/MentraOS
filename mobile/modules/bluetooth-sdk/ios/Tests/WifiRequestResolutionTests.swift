@testable import MentraBluetoothSDK
import XCTest

final class WifiRequestResolutionTests: XCTestCase {
    @MainActor
    func testUnsupportedControllerDoesNotClaimWifiDispatch() {
        let keys = ["fullyBooted", "connected", "connectionState", "micEnabled", "voiceActivityDetectionEnabled", "bluetoothClassicConnected"]
        let snapshot = keys.compactMap { key in DeviceStore.shared.get("glasses", key).map { (key, $0) } }
        defer { for (key, value) in snapshot {
            DeviceStore.shared.apply("glasses", key, value)
        } }
        let controller: SGCManager = Simulated()
        XCTAssertFalse(controller.forgetWifiNetwork("AP", requestId: nil, sid: nil))
        XCTAssertFalse(controller.forgetWifiNetwork("AP", requestId: "request", sid: "sid"))
        XCTAssertFalse(controller.requestSavedWifiNetworks(requestId: "request", sid: "sid"))
    }

    func testFutureFractionalAndMalformedCapabilitiesAreUnsupportedNotLegacy() {
        for version in [0, 2, -1, 1.5, "1", true, NSNull()] as [Any] {
            let capabilities = WifiSessionCapabilities()
            capabilities.reset(sessionId: "sid")
            capabilities.applyVersionInfo1(["wifiForgetResultVersion": version, "savedWifiNetworksVersion": version])
            XCTAssertEqual(capabilities.forgetMode(), .unsupported)
            XCTAssertEqual(capabilities.savedNetworksMode(), .unsupported)
        }
        let missingSession = WifiSessionCapabilities()
        missingSession.applyVersionInfo1(["wifiForgetResultVersion": 1])
        XCTAssertEqual(missingSession.forgetMode(), .unsupported)
    }

    func testRawResponseRejectsPartialTuplesAndCoercionBeforeNormalization() {
        let tuple: [String: Any] = ["protocol_version": 1, "requestId": "request", "sid": "sid"]
        XCTAssertTrue(wifiResponseEnvelopeIsValid(tuple, allowLegacy: false))
        for key in tuple.keys {
            XCTAssertFalse(wifiResponseEnvelopeIsValid(tuple.filter { $0.key != key }, allowLegacy: true))
        }
        for version in [0, 2, 1.5, "1", true, NSNull()] as [Any] {
            var malformed = tuple
            malformed["protocol_version"] = version
            XCTAssertFalse(wifiResponseEnvelopeIsValid(malformed, allowLegacy: true))
        }
        XCTAssertFalse(wifiResponseEnvelopeIsValid(tuple.merging(["connected": 0]) { _, new in new }, allowLegacy: true))
        XCTAssertFalse(wifiResponseEnvelopeIsValid(tuple.merging(["dispatched": true]) { _, new in new }, allowLegacy: true))
        XCTAssertTrue(wifiResponseEnvelopeIsValid(["dispatched": true], allowLegacy: true))
        XCTAssertFalse(wifiResponseEnvelopeIsValid(["requestId": "", "dispatched": true], allowLegacy: true))
        XCTAssertFalse(wifiResponseEnvelopeIsValid([:], allowLegacy: false))
    }

    func testSemanticResultsOmitTransportMetadata() throws {
        let data: [String: Any] = ["requestId": "request", "sid": "sid", "protocolVersion": 1,
                                   "ssid": "AP", "outcome": "confirmed", "networks": ["AP"]]
        let forbidden: Set = ["mode", "capabilityVersion", "requestId", "sid", "protocolVersion"]
        let forget = try XCTUnwrap(parseWifiForgetResult(expectedRequestId: "request", expectedSid: "sid", expectedSsid: "AP", capabilityVersion: 1, data: data))
        let saved = try XCTUnwrap(parseSavedWifiNetworks(expectedRequestId: "request", expectedSid: "sid", capabilityVersion: 1, data: data))
        XCTAssertTrue(Set(forget.values.keys).isDisjoint(with: forbidden))
        XCTAssertTrue(Set(saved.values.keys).isDisjoint(with: forbidden))
        for version in [1.5, true] as [Any] {
            var malformed = data
            malformed["protocolVersion"] = version
            XCTAssertNil(parseWifiForgetResult(expectedRequestId: "request", expectedSid: "sid", expectedSsid: "AP", capabilityVersion: 1, data: malformed))
            XCTAssertNil(parseSavedWifiNetworks(expectedRequestId: "request", expectedSid: "sid", capabilityVersion: 1, data: malformed))
        }
    }

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
        XCTAssertEqual(capabilities.savedNetworks, .legacy)
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
            ssid: "AP"
        )

        XCTAssertTrue(Set(result.values.keys).isDisjoint(with: ["mode", "capabilityVersion", "requestId", "sid"]))
        XCTAssertEqual(result.outcome, .legacyUnverified)
        XCTAssertNil(result.connected)
        XCTAssertNil(result.currentSsid)
        XCTAssertNil(result.localIp)
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
        failure["networks"] = [String]()
        let parsedFailure = parseSavedWifiNetworks(
            expectedRequestId: "saved-1",
            expectedSid: "sid-1",
            capabilityVersion: 1,
            data: failure
        )
        XCTAssertEqual(parsedFailure?.outcome, .failed)
        XCTAssertEqual(parsedFailure?.error, "backend_failed")
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
            requestId: "",
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
