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
