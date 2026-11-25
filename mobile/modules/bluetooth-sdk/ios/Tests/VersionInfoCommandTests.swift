@testable import MentraBluetoothSDK
import XCTest

@MainActor
private final class VersionInfoCommandTransport: MentraLive {
    var requestId: String?
    var requestIds: [String] = []
    var reply = true
    var includeResponseId = true
    var metadataOverrides: [String: Any] = [:]
    /// How many of the two response chunks the glasses get out for each request, in order;
    /// both when unlisted. A process that restarts mid-reply sends only its first.
    var chunksSentPerRequest: [Int] = []

    /// The glasses process answering; a restart starts a new one.
    var sid = "asg-1"

    override func sendJson(_ jsonOriginal: [String: Any], wakeUp: Bool, requireAck: Bool) {
        // A restart re-runs readiness: only version requests are answered here.
        guard jsonOriginal["type"] as? String == "request_version" else { return }
        XCTAssertTrue(wakeUp, "An idle ASG must wake to finish its version response")
        XCTAssertTrue(requireAck)
        do {
            let bytes = try JSONSerialization.data(withJSONObject: jsonOriginal)
            let command = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
            let id = try XCTUnwrap(command["request_id"] as? String)
            requestId = id
            requestIds.append(id)
            guard reply else { return }
            let sent = requestIds.count <= chunksSentPerRequest.count ? chunksSentPerRequest[requestIds.count - 1] : 2
            try sendVersionInfo(requestId: includeResponseId ? id : nil, chunks: sent)
        } catch {
            XCTFail("Could not replay version request: \(error)")
        }
    }

    /// A process that just started announces its versions unasked, without a request id.
    func restart(sid: String) throws {
        self.sid = sid
        try sendVersionInfo(requestId: nil, chunks: 2)
    }

    private func sendVersionInfo(requestId: String?, chunks: Int) throws {
        var common: [String: Any] = ["sid": sid, "chunkCount": 2]
        if let requestId { common["request_id"] = requestId }
        for chunk: [String: Any] in [
            ["type": "version_info_1", "chunkIndex": 1, "final": false,
             "build_number": "303000008", "app_version": "3.3.0"],
            ["type": "version_info_3", "chunkIndex": 2, "final": true,
             "bes_fw_version": "26.9.23.0", "mtk_fw_version": "MentraLive_20260921.0"],
        ].prefix(chunks) {
            let response = common.merging(chunk) { _, value in value }
                .merging(metadataOverrides) { _, value in value }
            try processReceivedData(JSONSerialization.data(withJSONObject: response))
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
        XCTAssertEqual(diagnostics[1]["_responseChunkIndex"] as? String, "number:1")
        XCTAssertEqual(diagnostics[2]["_responseChunkIndex"] as? String, "number:2")
        XCTAssertEqual(diagnostics[1]["_responseFinal"] as? String, "boolean:false")
        XCTAssertFalse(diagnostics.contains { $0["besFirmwareVersion"] != nil || $0["serialNumber"] != nil })
    }

    func testSecondCallerJoinsThePendingRequestAndSharesItsCancellation() async throws {
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
        let owner = Task { try await sdk.requestVersionInfo() }
        while transport.requestId == nil {
            await Task.yield()
        }
        let joiner = Task { try await sdk.requestVersionInfo() }
        for _ in 0 ..< 10 {
            await Task.yield()
        }
        owner.cancel()
        for task in [owner, joiner] {
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
        }
        XCTAssertEqual(transport.requestIds.count, 1, "A joined caller must not send a second request")
        XCTAssertEqual(diagnostics.compactMap { $0["stage"] as? String }, [
            "registered", "response-ignored", "response-ignored", "rejected",
        ])
        XCTAssertTrue(diagnostics.allSatisfy { $0["requestId"] as? String == transport.requestId })
        XCTAssertEqual(diagnostics[1]["responseRequestId"] as? String, "")
    }

    func testGlassesThatRestartWhileARequestWaitsAreAskedAgainAndAnswerEveryCaller() async throws {
        let previous = DeviceManager.shared.sgc
        let transport = VersionInfoCommandTransport()
        // The first process gets out only its first chunk before it restarts.
        transport.chunksSentPerRequest = [1]
        DeviceManager.shared.sgc = transport
        let sdk = MentraBluetoothSDK()
        var diagnostics: [[String: Any]] = []
        let sink = Bridge.addEventSink { event, body in
            if let diagnostic = self.diagnostic(event, body) { diagnostics.append(diagnostic) }
        }
        defer {
            Bridge.removeEventSink(sink)
            sdk.invalidate()
            transport.cleanup()
            DeviceManager.shared.sgc = previous
        }
        let poll = Task { try await sdk.requestVersionInfo() }
        while transport.requestIds.isEmpty {
            await Task.yield()
        }
        // The update check asks while the poll's request is still waiting.
        let check = Task { try await sdk.requestVersionInfo() }
        for _ in 0 ..< 10 {
            await Task.yield()
        }
        try transport.restart(sid: "asg-2")

        let polled = try await poll.value
        let checked = try await check.value

        XCTAssertEqual(transport.requestIds.count, 2)
        XCTAssertEqual(Set(transport.requestIds).count, 1, "The restarted glasses are asked under the same id")
        for result in [polled, checked] {
            XCTAssertEqual(result.buildNumber, "303000008")
            XCTAssertEqual(result.besFirmwareVersion, "26.9.23.0")
            XCTAssertEqual(result.mtkFirmwareVersion, "MentraLive_20260921.0")
        }
        XCTAssertEqual(diagnostics.compactMap { $0["stage"] as? String }, [
            // The restarted process's announcement, which carries no request id, is what asks it again.
            "registered", "response-waiting", "asked-restarted-glasses", "response-waiting", "response-complete",
            "resolved",
        ])
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

    func testMalformedMetadataRetainsItsTypeThroughTheActualBridgeLog() async throws {
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
        for (wireKey, logKey, value, expected) in [
            ("chunkIndex", "_responseChunkIndex", true as Any, "boolean:true"),
            ("chunkCount", "_responseChunkCount", true as Any, "boolean:true"),
            ("final", "_responseFinal", 1 as Any, "number:1"),
        ] {
            diagnostics.removeAll()
            transport.requestId = nil
            transport.metadataOverrides = [wireKey: value]
            let task = Task { try await sdk.requestVersionInfo() }
            while transport.requestId == nil {
                await Task.yield()
            }
            task.cancel()
            do {
                _ = try await task.value
                XCTFail("Malformed metadata must not resolve")
            } catch let error as BluetoothSdkError {
                XCTAssertEqual(error.code, "request_cancelled")
            }
            let ignored = diagnostics.filter { $0["stage"] as? String == "response-ignored" }
            XCTAssertEqual(ignored.count, 2)
            XCTAssertTrue(ignored.allSatisfy { $0[logKey] as? String == expected })
        }
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
