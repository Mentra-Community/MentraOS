@testable import MentraBluetoothSDK
import XCTest

/// Keep native serialization and fragment packing; replace only the radio writes.
@MainActor
private final class BesCrashTransport: MentraLive {
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
final class BesCrashReportTests: XCTestCase {
    private let keyA = "ML395018B-dump-0000002a-1f2e3d4c"
    private let keyB = "ML395018B-reset-9f3a0c1b2d4e5f60"

    private func ack(_ key: String, _ reportId: String?, ok: Bool, error: String? = nil) -> [String: Any] {
        var values: [String: Any] = ["type": "bes_crash_reported_ack", "incidentKey": key, "ok": ok]
        if let reportId { values["reportId"] = reportId }
        if let error { values["error"] = error }
        return values
    }

    private func expectCode(_ code: String, _ body: () async throws -> Void) async -> BluetoothSdkError? {
        do {
            try await body()
            XCTFail("expected \(code)")
            return nil
        } catch {
            let sdkError = error as? BluetoothSdkError
            XCTAssertEqual(sdkError?.code, code)
            return sdkError
        }
    }

    func testAckDeliveredDuringSendResolves() async throws {
        let waiters = BesCrashReportWaiters()
        try await waiters.report(incidentKey: keyA, reportId: "rep_1", timeoutMs: 1000) {
            XCTAssertEqual(waiters.onAck(ack(keyA, "rep_1", ok: true)), 1)
        }
    }

    func testConcurrentIncidentsSettleOnlyTheirOwnCall() async throws {
        let waiters = BesCrashReportWaiters()
        let b = Task { @MainActor in
            try await waiters.report(incidentKey: keyB, reportId: "rep_b", timeoutMs: 300) {}
        }
        try await waiters.report(incidentKey: keyA, reportId: "rep_a", timeoutMs: 1000) {
            XCTAssertEqual(waiters.onAck(ack(keyA, "rep_a", ok: true)), 1)
        }
        _ = await expectCode("request_timeout") { try await b.value }
    }

    func testStaleReportIdIsIgnored() async {
        let waiters = BesCrashReportWaiters()
        _ = await expectCode("request_timeout") {
            try await waiters.report(incidentKey: keyA, reportId: "rep_new", timeoutMs: 200) {
                XCTAssertEqual(waiters.onAck(ack(keyA, "rep_old", ok: true)), 0)
            }
        }
    }

    func testOkFalseRejectsWithGlassesError() async {
        let waiters = BesCrashReportWaiters()
        let error = await expectCode("bes_crash_report_rejected") {
            try await waiters.report(incidentKey: keyA, reportId: "rep_1", timeoutMs: 1000) {
                XCTAssertEqual(waiters.onAck(ack(keyA, "rep_1", ok: false, error: "unknown_incident")), 1)
            }
        }
        XCTAssertTrue(error?.message.contains("unknown_incident") == true)
    }

    func testOkTrueWithoutReportIdDoesNotResolve() async {
        let waiters = BesCrashReportWaiters()
        _ = await expectCode("request_timeout") {
            try await waiters.report(incidentKey: keyA, reportId: "rep_1", timeoutMs: 200) {
                XCTAssertEqual(waiters.onAck(ack(keyA, nil, ok: true)), 0)
            }
        }
    }

    func testDisconnectRejectsPendingCalls() async {
        let waiters = BesCrashReportWaiters()
        _ = await expectCode("glasses_not_connected") {
            try await waiters.report(incidentKey: keyA, reportId: "rep_1", timeoutMs: 5000) {
                waiters.rejectAll(BluetoothSdkError(code: "glasses_not_connected", message: "disconnected"))
            }
        }
    }

    func testSendFailureLeavesNoWaiter() async {
        let waiters = BesCrashReportWaiters()
        _ = await expectCode("glasses_not_connected") {
            try await waiters.report(incidentKey: keyA, reportId: "rep_1", timeoutMs: 1000) {
                throw BluetoothSdkError(code: "glasses_not_connected", message: "no link")
            }
        }
        XCTAssertEqual(waiters.onAck(ack(keyA, "rep_1", ok: true)), 0)
    }

    func testCommandIsQueuedWithWakeUp() throws {
        let live = BesCrashTransport()
        try live.sendBesCrashReported(incidentKey: keyA, reportId: "rep_01M4HBVT88DFSN8TYNZ1WTV4PB")
        XCTAssertEqual(live.writes.compactMap { $0.1?.commandType }, ["bes_crash_reported"])
        XCTAssertTrue(live.writes.allSatisfy { $0.1?.wakeup == true })
        let wire = live.writes.map { String(decoding: $0.0, as: UTF8.self) }.joined()
        XCTAssertTrue(wire.contains(keyA))
        XCTAssertTrue(wire.contains("rep_01M4HBVT88DFSN8TYNZ1WTV4PB"))
    }

    func testCommandRejectsWithoutLink() {
        let live = BesCrashTransport()
        live.ready = false
        XCTAssertThrowsError(try live.sendBesCrashReported(incidentKey: keyA, reportId: "rep_1")) { error in
            XCTAssertEqual((error as? BluetoothSdkError)?.code, "glasses_not_connected")
        }
        XCTAssertTrue(live.writes.isEmpty)
    }

    func testDetectedEventReportsNullBeforeAReport() {
        let event = BesCrashDetectedEvent(values: ["incidentKey": keyA, "reportId": NSNull(), "summary": ["traceGaps": 0]])
        XCTAssertNil(event.reportId)
        XCTAssertTrue(event.values["reportId"] is NSNull)
        XCTAssertEqual(event.summary["traceGaps"] as? Int, 0)
        XCTAssertEqual(BesCrashDetectedEvent(values: ["reportId": "rep_1"]).reportId, "rep_1")
    }

    func testRelayFileNamesAreRecognized() {
        XCTAssertTrue(MentraLive.isIncidentRelayFileName("Brep_01m4hbvt88d"))
        XCTAssertTrue(MentraLive.isIncidentRelayFileName("Lrep_01m4hbvt88d"))
        for name in ["I000123456", "I000123456.jpg", "ble_1234567890", "Brep_01m4hbvt88d.json", "Xrep_01m4hbvt88d", ""] {
            XCTAssertFalse(MentraLive.isIncidentRelayFileName(name), name)
        }
    }
}
