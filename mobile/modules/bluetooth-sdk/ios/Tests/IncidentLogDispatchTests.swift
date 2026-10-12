@testable import MentraBluetoothSDK
import XCTest

/// Keep native admission, serialization and fragment packing; replace only the radio writes.
@MainActor
private final class IncidentLogTransport: MentraLive {
    var ready = true
    var writes: [(Data, BleWriteTrace?)] = []

    override var incidentLogTransportReady: Bool {
        ready
    }

    override func queueSend(_ data: Data, id _: String, trace: BleWriteTrace?) {
        writes.append((data, trace))
    }
}

/// Stands in for Cloud so the tests observe the report each relayed file is posted to.
private final class CloudStub: URLProtocol {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var requests: [String] = []

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "cloud-stub.invalid"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(buffer, count: count)
            }
            stream.close()
        }
        let path = request.url?.path ?? ""
        DispatchQueue.main.sync { CloudStub.requests.append("\(path) \(String(decoding: body, as: UTF8.self))") }
        let response = HTTPURLResponse(url: request.url!, statusCode: CloudStub.status, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
final class IncidentLogDispatchTests: XCTestCase {
    private let incident = "rep_01M4HBVT88DFSN8TYNZ1WTV4PB"
    private let apiBase = "https://core.dev.us-west-2.mentraglass.com"

    func testMissingNativeLinkRejectsDespiteCachedConnectedStatus() {
        let live = MentraLive()
        let store = DeviceStore.shared.store
        let saved = store.getCategory("glasses")["connected"]
        store.set("glasses", "connected", true)
        defer {
            if let saved { store.set("glasses", "connected", saved) }
            else { store.remove("glasses", "connected") }
        }
        XCTAssertThrowsError(try live.sendIncidentId(incident, apiBaseUrl: apiBase)) { error in
            XCTAssertEqual((error as? BluetoothSdkError)?.code, "glasses_not_connected")
        }
    }

    func testNoDriverRejectsThroughDeviceManager() {
        let manager = DeviceManager()
        manager.sgc = nil
        XCTAssertThrowsError(try manager.sendIncidentId(incident, apiBaseUrl: apiBase)) { error in
            XCTAssertEqual((error as? BluetoothSdkError)?.code, "glasses_not_connected")
        }
    }

    func testMissingCurrentTokenDoesNotQueueAnUpload() throws {
        try withToken("") {
            let live = IncidentLogTransport()
            XCTAssertThrowsError(try live.sendIncidentId(incident, apiBaseUrl: apiBase)) { error in
                XCTAssertEqual((error as? BluetoothSdkError)?.code, "core_token_unavailable")
            }
            XCTAssertTrue(live.writes.isEmpty)
        }
    }

    func testCurrentTokenPrecedesUploadAndNeverAppearsInLogs() throws {
        let token = "synthetic-\(UUID().uuidString)"
        try withToken(token) {
            let live = IncidentLogTransport()
            let manager = DeviceManager()
            manager.sgc = live
            var logs: [String] = []
            let sink = Bridge.addEventSink { event, body in
                if event == "log", let message = body["message"] as? String { logs.append(message) }
            }
            defer { Bridge.removeEventSink(sink) }

            try manager.sendIncidentId(incident, apiBaseUrl: apiBase)

            XCTAssertEqual(live.writes.compactMap { $0.1?.commandType }, ["auth_token", "upload_incident_logs"])
            XCTAssertTrue(live.writes.allSatisfy { $0.1?.wakeup == true })
            let wire = live.writes.map { String(decoding: $0.0, as: UTF8.self) }.joined()
            XCTAssertTrue(wire.contains(token), "The current token must reach the glasses")
            XCTAssertTrue(wire.contains(incident))
            XCTAssertFalse(logs.contains { $0.contains(token) }, "Tokens must stay out of native and incident logs")
        }
    }

    func testAllTokenFragmentsPrecedeUpload() throws {
        try withToken(String(repeating: "synthetic", count: 120)) {
            let live = IncidentLogTransport()
            try live.sendIncidentId(incident, apiBaseUrl: apiBase)
            let types = live.writes.compactMap { $0.1?.commandType }
            XCTAssertGreaterThan(types.filter { $0 == "auth_token" }.count, 1)
            XCTAssertEqual(types.last, "upload_incident_logs")
            XCTAssertTrue(types.dropLast().allSatisfy { $0 == "auth_token" })
        }
    }

    func testCommandQueueInsertionAndSessionClearAreSynchronous() {
        let queue = MentraLive.CommandQueue()
        let first = MentraLive.PendingMessage(data: Data([1]), id: "auth", retries: 0)
        let second = MentraLive.PendingMessage(data: Data([2]), id: "upload", retries: 0)
        XCTAssertEqual(queue.enqueue(first), 1)
        XCTAssertEqual(queue.enqueue(second), 2)
        XCTAssertEqual(queue.dequeue()?.id, "auth")
        queue.removeAll()
        XCTAssertNil(queue.dequeue())
    }

    func testCollidingReportWaitsForOwnerCloudConfirmationAndNeverReceivesItsEvidence() async throws {
        try await withCloud(status: 200) {
            let live = IncidentLogTransport()
            let name = "Brep_01m4hbvt88d"
            try live.sendIncidentId(incident, apiBaseUrl: cloudBase)
            XCTAssertThrowsError(try live.sendIncidentId(collidingIncident, apiBaseUrl: cloudBase)) { error in
                XCTAssertEqual((error as? BluetoothSdkError)?.code, "incident_relay_busy")
            }
            XCTAssertFalse(wire(live).contains(collidingIncident))
            XCTAssertEqual(live.bleIncidentLogRelays[name]?.incidentId, incident)
            XCTAssertEqual(live.bleIncidentLogRelays["Lrep_01m4hbvt88d"]?.incidentId, incident)

            let logcat = "Lrep_01m4hbvt88d"
            try await receive(live, name, "owner")
            XCTAssertEqual(CloudStub.requests, ["/api/client/reports/\(incident)/artifacts owner"])
            let confirmation = try XCTUnwrap(sentMessages(live).last { $0.contains("transfer_complete") })
            XCTAssertTrue(confirmation.contains(name) && confirmation.contains("\"success\":true"))
            XCTAssertThrowsError(try live.sendIncidentId(collidingIncident, apiBaseUrl: cloudBase)) { error in
                XCTAssertEqual((error as? BluetoothSdkError)?.code, "incident_relay_busy")
            }
            try await receive(live, logcat, "owner-logcat")

            try live.sendIncidentId(collidingIncident, apiBaseUrl: cloudBase)
            try await receive(live, name, "second")
            XCTAssertEqual(CloudStub.requests.last, "/api/client/reports/\(collidingIncident)/artifacts second")
        }
    }

    func testFailedCloudPostKeepsOwnerUntilOwnershipExpires() async throws {
        try await withCloud(status: 500) {
            let live = IncidentLogTransport()
            var now: TimeInterval = 1000
            live.incidentRelayClock = { now }
            let name = "Brep_01m4hbvt88d"
            try live.sendIncidentId(incident, apiBaseUrl: cloudBase)
            live.uploadBleIncidentLogRelay(
                relay: try XCTUnwrap(live.bleIncidentLogRelays[name]), fileName: name, data: Data("owner".utf8)
            )
            try await waitFor { wire(live).contains("transfer_complete") }
            XCTAssertEqual(live.bleIncidentLogRelays[name]?.incidentId, incident)
            XCTAssertThrowsError(try live.sendIncidentId(collidingIncident, apiBaseUrl: cloudBase)) { error in
                XCTAssertEqual((error as? BluetoothSdkError)?.code, "incident_relay_busy")
            }

            now += MentraLive.incidentRelayOwnershipSeconds
            try live.sendIncidentId(collidingIncident, apiBaseUrl: cloudBase)
            XCTAssertEqual(live.bleIncidentLogRelays[name]?.incidentId, collidingIncident)
        }
    }

    func testDispatchFailureOfRefusedReportCannotReleaseOwner() throws {
        try withToken("synthetic") {
            let live = IncidentLogTransport()
            try live.sendIncidentId(incident, apiBaseUrl: apiBase)
            live.ready = false
            XCTAssertThrowsError(try live.sendIncidentId(collidingIncident, apiBaseUrl: apiBase))
            XCTAssertEqual(live.bleIncidentLogRelays["Brep_01m4hbvt88d"]?.incidentId, incident)
        }
    }

    private let collidingIncident = "rep_01M4HBVT88DZZZZZZZZZZZZZZZ"
    private let cloudBase = "https://cloud-stub.invalid"

    /// Each message is wrapped as {"C":"<escaped json>"}; unescape so assertions read the message.
    private func sentMessages(_ live: IncidentLogTransport) -> [String] {
        live.writes.map { String(decoding: $0.0, as: UTF8.self).replacingOccurrences(of: "\\\"", with: "\"") }
    }

    private func wire(_ live: IncidentLogTransport) -> String {
        sentMessages(live).joined()
    }

    private func withCloud(status: Int, body: () async throws -> Void) async throws {
        CloudStub.status = status
        CloudStub.requests = []
        URLProtocol.registerClass(CloudStub.self)
        defer { URLProtocol.unregisterClass(CloudStub.self) }
        let store = DeviceStore.shared.store
        let saved = store.getCategory("bluetooth")["core_token"]
        store.set("bluetooth", "core_token", "synthetic")
        defer {
            if let saved { store.set("bluetooth", "core_token", saved) }
            else { store.remove("bluetooth", "core_token") }
        }
        try await body()
    }

    private func receive(_ live: IncidentLogTransport, _ name: String, _ payload: String) async throws {
        let relay = try XCTUnwrap(live.bleIncidentLogRelays[name])
        live.uploadBleIncidentLogRelay(relay: relay, fileName: name, data: Data(payload.utf8))
        try await waitFor { live.bleIncidentLogRelays[name] !== relay }
    }

    private func waitFor(_ condition: () -> Bool) async throws {
        for _ in 0 ..< 500 where !condition() {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertTrue(condition())
    }

    private func withToken<T>(_ value: String, body: () throws -> T) rethrows -> T {
        let store = DeviceStore.shared.store
        let saved = store.getCategory("bluetooth")["core_token"]
        store.set("bluetooth", "core_token", value)
        defer {
            if let saved { store.set("bluetooth", "core_token", saved) }
            else { store.remove("bluetooth", "core_token") }
        }
        return try body()
    }
}
