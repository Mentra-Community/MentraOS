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

    func testCoreUrlStaysOnThePhone() throws {
        try withToken("synthetic") {
            let live = IncidentLogTransport()
            try live.sendIncidentId(incident, apiBaseUrl: apiBase)
            XCTAssertTrue(sentMessages(live).joined().contains("upload_incident_logs"))
            XCTAssertFalse(sentMessages(live).joined().contains("apiBaseUrl"))
        }
    }

    func testNoCoreUrlRejectsInsteadOfSendingLogsAnywhereElse() throws {
        try withToken("synthetic") {
            let live = IncidentLogTransport()
            for base in [nil, "  "] as [String?] {
                XCTAssertThrowsError(try live.sendIncidentId(incident, apiBaseUrl: base)) { error in
                    XCTAssertEqual((error as? BluetoothSdkError)?.code, "core_url_unavailable")
                }
            }
            XCTAssertTrue(live.writes.isEmpty)
            XCTAssertTrue(live.bleIncidentLogRelays.isEmpty)
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
            XCTAssertTrue(CloudStub.requests.isEmpty)
            let confirmation = try XCTUnwrap(sentMessages(live).last { $0.contains("transfer_complete") })
            XCTAssertTrue(confirmation.contains(name) && confirmation.contains("\"success\":true"))
            XCTAssertThrowsError(try live.sendIncidentId(collidingIncident, apiBaseUrl: cloudBase)) { error in
                XCTAssertEqual((error as? BluetoothSdkError)?.code, "incident_relay_busy")
            }
            try await receive(live, logcat, "owner-logcat")
            try await waitFor { CloudStub.requests.count == 2 }
            XCTAssertEqual(CloudStub.requests, [
                "/api/client/reports/\(incident)/artifacts owner-logcat",
                "/api/client/reports/\(incident)/artifacts owner",
            ])

            try live.sendIncidentId(collidingIncident, apiBaseUrl: cloudBase)
            try await receive(live, name, "second")
            XCTAssertEqual(CloudStub.requests.count, 2)
            try await receive(live, logcat, "second-logcat")
            try await waitFor { CloudStub.requests.count == 4 }
            XCTAssertEqual(CloudStub.requests[2], "/api/client/reports/\(collidingIncident)/artifacts second-logcat")
            XCTAssertEqual(CloudStub.requests.last, "/api/client/reports/\(collidingIncident)/artifacts second")
        }
    }

    func testSavesTheBesLogAndUploadsTheMtkLogBeforeIt() async throws {
        try await withCloud(status: 200) {
            let live = IncidentLogTransport()
            let name = "Brep_01m4hbvt88d"
            let logcat = "Lrep_01m4hbvt88d"
            try live.sendIncidentId(incident, apiBaseUrl: cloudBase)
            let bes = "{\"retryKey\":\"bes-crash\",\"entries\":[{\"source\":\"BES\"}]}"
            try await receive(live, name, bes)
            XCTAssertTrue(CloudStub.requests.isEmpty)
            XCTAssertEqual(live.bleIncidentLogRelays[name]?.incidentId, incident)

            try await receive(live, logcat, "{\"entries\":[{\"source\":\"MTK\"}]}")
            try await waitFor { CloudStub.requests.count == 2 }
            XCTAssertEqual(
                CloudStub.requests,
                [
                    "/api/client/reports/\(incident)/artifacts {\"entries\":[{\"source\":\"MTK\"}]}",
                    "/api/client/reports/\(incident)/artifacts \(bes)",
                ]
            )
            XCTAssertNil(live.bleIncidentLogRelays[name])
            XCTAssertNil(live.bleIncidentLogRelays[logcat])
        }
    }

    func testHeldBesLogIsDurablyPersistedAndResumedAfterProcessDeath() async throws {
        clearHeldBesDir()
        try await withCloud(status: 200) {
            let live = IncidentLogTransport()
            let name = "Brep_01m4hbvt88d"
            try live.sendIncidentId(incident, apiBaseUrl: cloudBase)
            let bes = "{\"source\":\"BES\"}"
            try await receive(live, name, bes)
            // Acknowledged to the glasses but not uploaded yet: the bytes must already be on disk.
            XCTAssertTrue(CloudStub.requests.isEmpty)
            XCTAssertTrue(besHeldFileExists(incident))

            // Process death before the MTK log arrives: a fresh instance owns no relay and the
            // glasses will not resend, so it must finish the upload from the durable copy.
            let revived = IncidentLogTransport()
            revived.resumePersistedBesUploads()
            try await waitFor {
                CloudStub.requests.contains("/api/client/reports/\(self.incident)/artifacts \(bes)")
            }
            try await waitFor { !self.besHeldFileExists(self.incident) }
        }
    }

    func testSavedBesLogWaitsForItsOwnAccountAndCore() async throws {
        clearHeldBesDir()
        defer { clearHeldBesDir() }
        try await withCloud(status: 200) {
            let store = DeviceStore.shared.store
            store.set("bluetooth", "core_token", jwt(iss: "https://core-a", sub: "user-a"))
            let live = IncidentLogTransport()
            let bes = "{\"source\":\"BES\"}"
            try live.sendIncidentId(incident, apiBaseUrl: cloudBase)
            try await receive(live, "Brep_01m4hbvt88d", bes)

            let revived = IncidentLogTransport()
            revived.besRetrySeconds = 0.05
            store.set("bluetooth", "core_token", jwt(iss: "https://core-b", sub: "user-a"))
            revived.resumePersistedBesUploads()
            try await Task.sleep(nanoseconds: 200_000_000)
            store.set("bluetooth", "core_token", jwt(iss: "https://core-a", sub: "user-b"))
            try await Task.sleep(nanoseconds: 200_000_000)
            XCTAssertTrue(CloudStub.requests.isEmpty)
            XCTAssertTrue(besHeldFileExists(incident))

            store.set("bluetooth", "core_token", jwt(iss: "https://core-a", sub: "user-a"))
            try await waitFor { !self.besHeldFileExists(self.incident) }
            XCTAssertEqual(CloudStub.requests.count, 1)
        }
    }

    private func jwt(iss: String, sub: String) -> String {
        let claims = Data("{\"iss\":\"\(iss)\",\"sub\":\"\(sub)\"}".utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "h.\(claims).s"
    }

    func testMtkTransferCutOffPartwayStopsHoldingTheBesLog() async throws {
        clearHeldBesDir()
        defer { clearHeldBesDir() }
        try await withCloud(status: 200) {
            let live = IncidentLogTransport()
            live.besHoldSeconds = 0.05
            live.besMtkWaitMaxSeconds = 0.3
            let bes = "{\"source\":\"BES\"}"
            try live.sendIncidentId(incident, apiBaseUrl: cloudBase)
            // Part of the MTK file arrived, then the link dropped: nothing will ever finish it.
            let mtk = try XCTUnwrap(live.bleIncidentLogRelays["Lrep_01m4hbvt88d"])
            mtk.session = MentraLiveFileTransferSession(
                fileName: "Lrep_01m4hbvt88d", fileSize: 100_000, announcedPackets: 1000
            )
            try await receive(live, "Brep_01m4hbvt88d", bes)

            try await Task.sleep(nanoseconds: 150_000_000)
            XCTAssertTrue(CloudStub.requests.isEmpty)

            try await waitFor { !self.besHeldFileExists(self.incident) }
            XCTAssertEqual(CloudStub.requests, ["/api/client/reports/\(incident)/artifacts \(bes)"])
        }
    }

    func testBesLogThatCannotBeSavedIsRefusedSoTheGlassesKeepTheirCopy() async throws {
        clearHeldBesDir()
        defer { clearHeldBesDir() }
        // A file where the directory belongs makes every save fail.
        let dir = try XCTUnwrap(besHeldDirURL())
        try FileManager.default.createDirectory(at: dir.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("not a directory".utf8).write(to: dir)
        try await withCloud(status: 200) {
            let live = IncidentLogTransport()
            let name = "Brep_01m4hbvt88d"
            try live.sendIncidentId(incident, apiBaseUrl: cloudBase)
            try await receive(live, name, "{\"source\":\"BES\"}")
            let confirmations = sentMessages(live).filter { $0.contains("transfer_complete") }
            XCTAssertEqual(confirmations.count, 1)
            XCTAssertTrue(confirmations[0].contains("false"))
            XCTAssertEqual(live.bleIncidentLogRelays[name]?.incidentId, incident)
        }
    }

    func testBesUploadThatFailsDuringAnOutageIsRetriedUntilCloudConfirmsIt() async throws {
        clearHeldBesDir()
        defer { clearHeldBesDir() }
        try await withCloud(status: 500) {
            let live = IncidentLogTransport()
            live.besHoldSeconds = 0.01
            live.besRetrySeconds = 0.05
            let name = "Brep_01m4hbvt88d"
            let bes = "{\"source\":\"BES\"}"
            try live.sendIncidentId(incident, apiBaseUrl: cloudBase)
            try await receive(live, name, bes)
            // No MTK log arrives, so after the hold the phone uploads the BES itself.
            try await waitFor { CloudStub.requests.count >= 2 }
            XCTAssertEqual(live.bleIncidentLogRelays[name]?.incidentId, incident)
            XCTAssertTrue(besHeldFileExists(incident))

            CloudStub.status = 200
            try await waitFor { !self.besHeldFileExists(self.incident) }
            XCTAssertNil(live.bleIncidentLogRelays[name])
        }
    }

    func testResumedBesUploadRetriesAfterFailureAndReconnectDoesNotDuplicateIt() async throws {
        clearHeldBesDir()
        defer { clearHeldBesDir() }
        try await withCloud(status: 500) {
            let live = IncidentLogTransport()
            try live.sendIncidentId(incident, apiBaseUrl: cloudBase)
            try await receive(live, "Brep_01m4hbvt88d", "{\"source\":\"BES\"}")

            let revived = IncidentLogTransport()
            revived.besRetrySeconds = 0.2
            revived.resumePersistedBesUploads()
            try await waitFor { CloudStub.requests.count == 2 } // Both attempts of one try.
            revived.resumePersistedBesUploads()
            revived.resumePersistedBesUploads()
            XCTAssertEqual(CloudStub.requests.count, 2)

            CloudStub.status = 200
            CloudStub.requests = []
            try await waitFor { !self.besHeldFileExists(self.incident) }
            XCTAssertEqual(CloudStub.requests.count, 1)
        }
    }

    func testBesLogCloudPermanentlyRefusesIsDroppedInsteadOfRetriedForever() async throws {
        clearHeldBesDir()
        defer { clearHeldBesDir() }
        try await withCloud(status: 404) {
            let live = IncidentLogTransport()
            try live.sendIncidentId(incident, apiBaseUrl: cloudBase)
            try await receive(live, "Brep_01m4hbvt88d", "{\"source\":\"BES\"}")

            let revived = IncidentLogTransport()
            revived.besRetrySeconds = 0.05
            revived.resumePersistedBesUploads()
            try await waitFor { !self.besHeldFileExists(self.incident) }
            try await Task.sleep(nanoseconds: 200_000_000)
            XCTAssertEqual(CloudStub.requests.count, 1)
        }
    }

    func testStaleCallbackOfFinishedOwnerCannotConfirmCollidingReportsFile() async throws {
        try await withCloud(status: 200) {
            let live = IncidentLogTransport()
            let name = "Brep_01m4hbvt88d"
            let logcat = "Lrep_01m4hbvt88d"
            try live.sendIncidentId(incident, apiBaseUrl: cloudBase)
            let staleRelay = try XCTUnwrap(live.bleIncidentLogRelays[name])
            try await receive(live, name, "owner")
            try await receive(live, logcat, "owner-logcat")
            try await waitFor { CloudStub.requests.count == 2 }
            try live.sendIncidentId(collidingIncident, apiBaseUrl: cloudBase)
            let confirmationsBefore = sentMessages(live).filter { $0.contains("transfer_complete") }.count
            let requestsBefore = CloudStub.requests.count

            // A late callback of the first report's file arrives while the colliding report owns the name.
            live.uploadBleIncidentLogRelay(relay: staleRelay, fileName: name, data: Data("late".utf8))
            try await Task.sleep(nanoseconds: 300_000_000)

            XCTAssertEqual(CloudStub.requests.count, requestsBefore)
            XCTAssertEqual(sentMessages(live).filter { $0.contains("transfer_complete") }.count, confirmationsBefore)
            XCTAssertEqual(live.bleIncidentLogRelays[name]?.incidentId, collidingIncident)
        }
    }

    func testFailedCloudPostKeepsOwnerUntilOwnershipExpires() async throws {
        try await withCloud(status: 500) {
            let live = IncidentLogTransport()
            var now: TimeInterval = 1000
            live.incidentRelayClock = { now }
            let name = "Brep_01m4hbvt88d"
            let logcat = "Lrep_01m4hbvt88d"
            try live.sendIncidentId(incident, apiBaseUrl: cloudBase)
            live.uploadBleIncidentLogRelay(
                relay: try XCTUnwrap(live.bleIncidentLogRelays[name]), fileName: name, data: Data("owner".utf8)
            )
            try await waitFor { wire(live).contains("\"success\":true") }
            XCTAssertTrue(CloudStub.requests.isEmpty)
            live.uploadBleIncidentLogRelay(
                relay: try XCTUnwrap(live.bleIncidentLogRelays[logcat]),
                fileName: logcat,
                data: Data("owner-logcat".utf8)
            )
            try await waitFor { wire(live).contains("\"success\":false") }
            XCTAssertEqual(CloudStub.requests, ["/api/client/reports/\(incident)/artifacts owner-logcat"])
            XCTAssertEqual(live.bleIncidentLogRelays[name]?.incidentId, incident)
            XCTAssertEqual(live.bleIncidentLogRelays[logcat]?.incidentId, incident)
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

    private func besHeldDirURL() -> URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("MentraLive_HeldBes", isDirectory: true)
    }

    private func besHeldFileExists(_ incidentId: String) -> Bool {
        guard let dir = besHeldDirURL() else { return false }
        let safe = String(incidentId.map { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == "_" ? $0 : "_" })
        return FileManager.default.fileExists(atPath: dir.appendingPathComponent(safe + ".json").path)
    }

    private func clearHeldBesDir() {
        guard let dir = besHeldDirURL() else { return }
        try? FileManager.default.removeItem(at: dir)
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
        let confirmations = sentMessages(live).filter { $0.contains("transfer_complete") }.count
        live.uploadBleIncidentLogRelay(relay: relay, fileName: name, data: Data(payload.utf8))
        if relay.kind == .firmware {
            try await waitFor {
                sentMessages(live).filter { $0.contains("transfer_complete") }.count > confirmations
            }
        } else {
            try await waitFor { live.bleIncidentLogRelays[name] !== relay }
        }
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
