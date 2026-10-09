@testable import MentraBluetoothSDK
import XCTest

@MainActor
private final class VersionInfoCommandTransport: MentraLive {
    var requestId: String?
    var reply = true
    var includeResponseId = true

    override func sendJson(_ jsonOriginal: [String: Any], wakeUp: Bool, requireAck: Bool) {
        XCTAssertEqual(jsonOriginal["type"] as? String, "request_version")
        XCTAssertTrue(wakeUp, "An idle ASG must wake to finish its version response")
        XCTAssertTrue(requireAck)
        do {
            let bytes = try JSONSerialization.data(withJSONObject: jsonOriginal)
            let command = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            let id = try XCTUnwrap(command["request_id"] as? String)
            requestId = id
            guard reply else { return }
            var common: [String: Any] = ["sid": "asg-1", "chunkCount": 2]
            if includeResponseId { common["request_id"] = id }
            for chunk: [String: Any] in [
                ["type": "version_info_1", "chunkIndex": 1, "final": false,
                 "build_number": "303000008", "app_version": "3.3.0"],
                ["type": "version_info_3", "chunkIndex": 2, "final": true,
                 "bes_fw_version": "26.9.23.0", "mtk_fw_version": "MentraLive_20260921.0"],
            ] {
                let response = common.merging(chunk) { _, value in value }
                try processReceivedData(JSONSerialization.data(withJSONObject: response))
            }
        } catch {
            XCTFail("Could not replay version request: \(error)")
        }
    }
}

@MainActor
final class VersionInfoCommandTests: XCTestCase {
    func testPublicVersionRequestWakesGlassesAndCombinesBothResponseChunks() async throws {
        let previous = DeviceManager.shared.sgc
        let transport = VersionInfoCommandTransport()
        DeviceManager.shared.sgc = transport
        let sdk = MentraBluetoothSDK()
        var diagnostics: [[String: Any]] = []
        let sink = Bridge.addEventSink { event, body in
            if let diagnostic = self.diagnostic(event, body) { diagnostics.append(diagnostic) }
        }
        defer {
            Bridge.removeEventSink(sink)
            sdk.invalidate()
            DeviceManager.shared.sgc = previous
        }

        let result = try await sdk.requestVersionInfo()

        XCTAssertNotNil(transport.requestId)
        XCTAssertEqual(result.buildNumber, "303000008")
        XCTAssertEqual(result.appVersion, "3.3.0")
        XCTAssertEqual(result.besFirmwareVersion, "26.9.23.0")
        XCTAssertEqual(result.mtkFirmwareVersion, "MentraLive_20260921.0")
        XCTAssertEqual(diagnostics.compactMap { $0["stage"] as? String }, [
            "registered", "response-waiting", "response-complete", "resolved",
        ])
        XCTAssertTrue(diagnostics.allSatisfy { $0["requestId"] as? String == transport.requestId })
        XCTAssertEqual(diagnostics[1]["responseRequestId"] as? String, transport.requestId)
        XCTAssertEqual(diagnostics[2]["responseChunk"] as? String, "version_info_3")
        XCTAssertEqual(diagnostics[1]["_responseChunkIndex"] as? String, "1")
        XCTAssertEqual(diagnostics[2]["_responseChunkIndex"] as? String, "2")
        XCTAssertFalse(diagnostics.contains { $0["besFirmwareVersion"] != nil || $0["serialNumber"] != nil })
    }

    func testUncorrelatedResponseAndCancellationRetainThePendingUuidAndOriginalError() async throws {
        let previous = DeviceManager.shared.sgc
        let transport = VersionInfoCommandTransport()
        transport.includeResponseId = false
        DeviceManager.shared.sgc = transport
        let sdk = MentraBluetoothSDK()
        var diagnostics: [[String: Any]] = []
        let sink = Bridge.addEventSink { event, body in
            if let diagnostic = self.diagnostic(event, body) { diagnostics.append(diagnostic) }
        }
        defer {
            Bridge.removeEventSink(sink)
            sdk.invalidate()
            DeviceManager.shared.sgc = previous
        }
        let task = Task { try await sdk.requestVersionInfo() }
        while transport.requestId == nil {
            await Task.yield()
        }
        do {
            _ = try await sdk.requestVersionInfo()
            XCTFail("The original pending request must retain its slot")
        } catch let error as BluetoothSdkError {
            XCTAssertEqual(error.code, "request_in_flight")
        }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("Uncorrelated responses must not complete the request")
        } catch let error as BluetoothSdkError {
            XCTAssertEqual(error.code, "request_cancelled")
            let rejected = try XCTUnwrap(diagnostics.last)
            XCTAssertEqual(rejected["stage"] as? String, "rejected")
            XCTAssertEqual(rejected["code"] as? String, error.code)
            XCTAssertEqual(rejected["message"] as? String, error.message)
        }
        XCTAssertEqual(diagnostics.compactMap { $0["stage"] as? String }, [
            "registered", "response-ignored", "response-ignored", "refused", "rejected",
        ])
        XCTAssertTrue(diagnostics.allSatisfy { $0["requestId"] as? String == transport.requestId })
        XCTAssertEqual(diagnostics[1]["responseRequestId"] as? String, "")
    }

    func testNoResponseRetainsTheOriginalTimeoutAndElapsedTime() async throws {
        let previous = DeviceManager.shared.sgc
        let transport = VersionInfoCommandTransport()
        transport.reply = false
        DeviceManager.shared.sgc = transport
        let sdk = MentraBluetoothSDK()
        var diagnostics: [[String: Any]] = []
        let sink = Bridge.addEventSink { event, body in
            if let diagnostic = self.diagnostic(event, body) { diagnostics.append(diagnostic) }
        }
        defer {
            Bridge.removeEventSink(sink)
            sdk.invalidate()
            DeviceManager.shared.sgc = previous
        }
        do {
            _ = try await sdk.requestVersionInfo()
            XCTFail("An absent response must time out")
        } catch let error as BluetoothSdkError {
            XCTAssertEqual(error.code, "request_timeout")
            let rejected = try XCTUnwrap(diagnostics.last)
            XCTAssertEqual(rejected["code"] as? String, error.code)
            XCTAssertEqual(rejected["message"] as? String, error.message)
            XCTAssertGreaterThanOrEqual(try XCTUnwrap(rejected["elapsedMs"] as? Int), 15000)
        }
        XCTAssertEqual(diagnostics.compactMap { $0["stage"] as? String }, ["registered", "rejected"])
        XCTAssertTrue(diagnostics.allSatisfy { $0["requestId"] as? String == transport.requestId })
    }

    private func diagnostic(_ event: String, _ body: [String: Any]) -> [String: Any]? {
        guard event == "log", let message = body["message"] as? String,
              message.contains("layer=sdk_version_request"),
              let payload = message.range(of: " payload="),
              let data = String(message[payload.upperBound...]).data(using: .utf8)
        else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }
}
