import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class LiveFirmwareUpdaterTests: XCTestCase {
    private func quietActivity(_ id: String) -> [String: Any] {
        ["schema": 1, "request_id": id, "consistent": true, "admission_held": false,
         "updating": false, "mtk_in_progress": false, "bes_in_progress": false,
         "session": ["status": "idle", "restart_pending": false]]
    }

    @MainActor
    private final class Harness {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        var writes = 0
        var queries = 0
        var token: UUID?
        let request = FirmwareStartRequest(deviceId: "live", connectionGeneration: 1, offerId: "offer", kind: "manifest",
                                           manifestUrl: "https://example.com/manifest?private=secret", metadata: ["authorization": "secret"])
        lazy var updater = makeUpdater()
        func makeUpdater(journalDirectory: URL? = nil) -> LiveFirmwareUpdater {
            let value = LiveFirmwareUpdater(deviceId: "live", generation: 1, connected: { true },
                                            query: { [unowned self] in queries += 1 }, directory: journalDirectory ?? directory)
            value.launch = { [unowned self, weak value] request in
                token = try value?.commandStarted(manifestUrl: request.manifestUrl!, request: request)
                writes += 1
            }
            return value
        }

        func cleanup() {
            try? FileManager.default.removeItem(at: directory)
        }
    }

    func testManagedStartAdoptsAndJournalsBeforeHandoffWithoutCredentials() async throws {
        try await MainActor.run {
            let h = Harness(); defer { h.cleanup() }
            let first = try h.updater.start(h.request)
            XCTAssertEqual(first.sessionId, try h.updater.start(h.request).sessionId)
            XCTAssertEqual(h.writes, 1); XCTAssertTrue(h.updater.ownsDevice)
            let saved = try XCTUnwrap(FirmwareJournal(deviceId: "live", directory: h.directory).read())
            XCTAssertNil(saved.request.manifestUrl); XCTAssertNil(saved.request.artifact)
            XCTAssertEqual(Set(saved.request.metadata.keys), ["manifestSha256"])
            XCTAssertFalse(saved.snapshot.safeToRelease)
            XCTAssertThrowsError(try h.updater.acknowledge())
        }
    }

    func testLostAckRequiresQueryAndColdRecordNeverResumesApproval() async throws {
        try await MainActor.run {
            let h = Harness(); defer { h.cleanup() }
            _ = try h.updater.start(h.request)
            h.updater.commandSettled(h.token!, error: FirmwareUpdaterError("timeout", "timeout"))
            XCTAssertEqual(h.updater.snapshot.phase, "interrupted")
            let recovered = h.makeUpdater()
            XCTAssertFalse(recovered.snapshot.safeToRelease)
            XCTAssertEqual(h.writes, 1)
            _ = try recovered.reconcile()
            XCTAssertEqual(h.queries, 1); XCTAssertEqual(h.writes, 1)
            recovered.status(sessionId: "", phase: "download", status: "idle", progress: 0, generation: 1)
            XCTAssertFalse(recovered.snapshot.safeToRelease)
            recovered.status(sessionId: "", phase: "download", status: "idle", progress: 0, generation: 1,
                             activity: quietActivity(recovered.beginStatusQuery()))
            XCTAssertTrue(recovered.snapshot.safeToRelease)
            _ = try recovered.acknowledge()
            XCTAssertNil(try FirmwareJournal(deviceId: "live", directory: h.directory).read())
            XCTAssertEqual(h.writes, 1)
        }
    }

    func testUnavailableNewJournalDoesNotOwnAnUnmodifiedDevice() async throws {
        try await MainActor.run {
            let h = Harness(); defer { h.cleanup() }
            _ = h.updater
            XCTAssertFalse(FileManager.default.fileExists(atPath: h.directory.path))
            try Data([1]).write(to: h.directory)
            let updater = h.makeUpdater()
            XCTAssertTrue(updater.snapshot.safeToRelease)
            XCTAssertThrowsError(try updater.start(h.request))
            XCTAssertTrue(updater.snapshot.safeToRelease); XCTAssertEqual(h.writes, 0)
            _ = try updater.acknowledge()
            XCTAssertTrue(h.makeUpdater().snapshot.safeToRelease)
        }
    }

    func testQuiescenceRequiresEveryOwnerKnownIdleAndConsistentRead() async throws {
        try await MainActor.run {
            let h = Harness(); defer { h.cleanup() }
            _ = try h.updater.start(h.request)
            h.updater.commandSettled(h.token!, error: nil)
            let invalid: [(String, Any)] = [
                ("schema", 2), ("schema", true), ("consistent", false), ("admission_held", true),
                ("updating", true), ("mtk_in_progress", true), ("bes_in_progress", true),
                ("bes_in_progress", 0), ("bes_in_progress", "false"),
                ("session", ["status": "in_progress", "restart_pending": false]),
                ("session", ["status": "idle", "restart_pending": true]), ("session", [String: Any]()),
            ]
            for (key, value) in invalid {
                var activity = quietActivity(h.updater.beginStatusQuery())
                activity[key] = value
                h.updater.status(sessionId: "", phase: "download", status: "idle", progress: 0, generation: 1, activity: activity)
                XCTAssertTrue(h.updater.ownsDevice, "Rejected \(key)=\(value)")
            }
            var missing = quietActivity(h.updater.beginStatusQuery())
            missing.removeValue(forKey: "bes_in_progress")
            h.updater.status(sessionId: "", phase: "download", status: "idle", progress: 0, generation: 1, activity: missing)
            XCTAssertTrue(h.updater.ownsDevice)
        }
    }

    func testStaleQueriesCannotReleaseChangedAttemptOrObservation() async throws {
        try await MainActor.run {
            let h = Harness(); defer { h.cleanup() }
            _ = try h.updater.start(h.request)
            h.updater.commandSettled(h.token!, error: nil)
            let old = quietActivity(h.updater.beginStatusQuery())
            _ = h.updater.beginStatusQuery()
            h.updater.status(sessionId: "", phase: "download", status: "idle", progress: 0, generation: 1, activity: old)
            XCTAssertTrue(h.updater.ownsDevice)
            let beforeProgress = quietActivity(h.updater.beginStatusQuery())
            h.updater.status(sessionId: "new", phase: "download", status: "in_progress", progress: 10, generation: 1)
            h.updater.status(sessionId: "", phase: "download", status: "idle", progress: 0, generation: 1, activity: beforeProgress)
            XCTAssertTrue(h.updater.ownsDevice)
            let beforeRetry = quietActivity(h.updater.beginStatusQuery())
            let token = try h.updater.commandStarted(manifestUrl: "https://example.com/retry")
            h.updater.commandSettled(token, error: nil)
            h.updater.status(sessionId: "", phase: "download", status: "idle", progress: 0, generation: 1, activity: beforeRetry)
            XCTAssertTrue(h.updater.ownsDevice)
            let beforeReconnect = quietActivity(h.updater.beginStatusQuery())
            h.updater.connectionChanged(generation: 2)
            h.updater.status(sessionId: "", phase: "download", status: "idle", progress: 0, generation: 2, activity: beforeReconnect)
            XCTAssertTrue(h.updater.ownsDevice)
            h.updater.status(sessionId: "", phase: "download", status: "idle", progress: 0, generation: 2,
                             activity: quietActivity(h.updater.beginStatusQuery()))
            XCTAssertFalse(h.updater.ownsDevice)
        }
    }

    func testIdleAfterStartAckCannotReleaseOwnershipBeforeTerminalStatus() async throws {
        try await MainActor.run {
            let h = Harness(); defer { h.cleanup() }
            h.updater.status(sessionId: "", phase: "download", status: "idle", progress: 0, generation: 1)
            XCTAssertFalse(h.updater.ownsDevice)
            _ = try h.updater.start(h.request)
            h.updater.commandSettled(h.token!, error: nil)
            // ASG acknowledges Start before fetching the manifest and creating its session.
            _ = try h.updater.reconcile()
            h.updater.status(sessionId: "", phase: "download", status: "idle", progress: 0, generation: 1)
            XCTAssertTrue(h.updater.ownsDevice)
            XCTAssertThrowsError(try h.updater.acknowledge())
            h.updater.status(sessionId: "new", phase: "download", status: "in_progress", progress: 10, generation: 1)
            h.updater.status(sessionId: "", phase: "download", status: "idle", progress: 0, generation: 1)
            XCTAssertTrue(h.updater.ownsDevice)
            h.updater.status(sessionId: "new", phase: "install", status: "complete", progress: 100, generation: 1)
            XCTAssertFalse(h.updater.ownsDevice)
            _ = try h.updater.acknowledge()
            XCTAssertNil(try FirmwareJournal(deviceId: "live", directory: h.directory).read())
        }
    }

    func testStatusBeforeAckAndSidChangesPreserveAuthoritativeOutcome() async throws {
        try await MainActor.run {
            let h = Harness(); defer { h.cleanup() }
            _ = try h.updater.start(h.request)
            h.updater.status(sessionId: "old", phase: "install", status: "in_progress", progress: 10, generation: 1)
            h.updater.status(sessionId: "new", phase: "install", status: "complete", progress: 100, generation: 1)
            h.updater.commandSettled(h.token!, error: FirmwareUpdaterError("timeout", "late timeout"))
            XCTAssertEqual(h.updater.snapshot.phase, "complete")
            XCTAssertEqual(h.updater.snapshot.inventory["glassesSessionId"], "new")
            XCTAssertFalse(h.updater.ownsDevice)
            _ = try h.updater.acknowledge()
            XCTAssertNil(try FirmwareJournal(deviceId: "live", directory: h.directory).read())
        }
    }

    func testIdleDuringPendingStartAndPriorConnectionCannotReleaseOwner() async throws {
        try await MainActor.run {
            let h = Harness(); defer { h.cleanup() }
            _ = try h.updater.start(h.request)
            h.updater.status(sessionId: "", phase: "download", status: "idle", progress: 0, generation: 1)
            XCTAssertFalse(h.updater.snapshot.safeToRelease)
            h.updater.connectionChanged(generation: 2)
            h.updater.status(sessionId: "stale", phase: "install", status: "complete", progress: 100, generation: 1)
            XCTAssertFalse(h.updater.snapshot.safeToRelease)
            XCTAssertThrowsError(try h.updater.start(h.request))
        }
    }

    func testObservedGlassesOwnedUpdateSurvivesAnotherPhoneRestartWithoutApproval() async throws {
        try await MainActor.run {
            let h = Harness(); defer { h.cleanup() }
            h.updater.status(sessionId: "already-running", phase: "install", status: "in_progress", progress: 40, generation: 1)
            XCTAssertEqual(h.updater.snapshot.progress, 0.4)
            let recovered = h.makeUpdater()
            XCTAssertFalse(recovered.snapshot.safeToRelease)
            XCTAssertEqual(recovered.snapshot.phase, "interrupted")
            XCTAssertEqual(recovered.snapshot.inventory["glassesSessionId"], "already-running")
            XCTAssertEqual(h.writes, 0)
            XCTAssertThrowsError(try recovered.start(h.request))
            _ = try recovered.reconcile()
            XCTAssertEqual(h.queries, 1); XCTAssertEqual(h.writes, 0)
        }
    }

    func testProviderCompletionReleasesOnlyTheMatchingSettledTransactionAndSurvivesRestart() async throws {
        try await MainActor.run {
            for kind in ["live-bes-reboot", "live-apk-build-increase", "live-apk-target-convergence"] {
                let h = Harness(); defer { h.cleanup() }
                func evidence(_ value: FirmwareUpdateSnapshot, kind: String) -> FirmwareCompletionEvidence {
                    .init(deviceId: value.deviceId, updaterId: value.updaterId, sessionId: value.sessionId!,
                          connectionGeneration: value.connectionGeneration, revision: value.revision, kind: kind)
                }
                _ = try h.updater.start(h.request)
                XCTAssertThrowsError(try h.updater.reconcileCompletion(evidence(h.updater.snapshot, kind: kind)))
                h.updater.commandSettled(h.token!, error: nil)
                h.updater.status(sessionId: "legacy", phase: "install", status: "step_complete", progress: 100, generation: 1)
                let old = h.updater.snapshot
                h.updater.connectionChanged(generation: 2, disconnected: true)
                XCTAssertTrue(h.updater.ownsDevice)
                XCTAssertThrowsError(try h.updater.reconcileCompletion(evidence(old, kind: kind)))
                let current = h.updater.snapshot
                XCTAssertThrowsError(try h.updater.reconcileCompletion(evidence(current, kind: "generic-reconnect")))
                for stale in ["device", "updater", "session", "revision"] {
                    var value = current
                    if stale == "device" { value.deviceId = "other" }
                    if stale == "updater" { value.updaterId = "other" }
                    if stale == "session" { value.sessionId = "other" }
                    if stale == "revision" { value.revision -= 1 }
                    XCTAssertThrowsError(try h.updater.reconcileCompletion(evidence(value, kind: kind)))
                }
                let proof = evidence(current, kind: kind)
                XCTAssertEqual(try h.updater.reconcileCompletion(proof).phase, "complete")
                XCTAssertFalse(h.updater.ownsDevice)
                XCTAssertTrue(h.makeUpdater().snapshot.safeToRelease)
                _ = try h.updater.commandStarted(manifestUrl: "http://local/next")
                XCTAssertThrowsError(try h.updater.reconcileCompletion(proof))
                XCTAssertTrue(h.updater.ownsDevice)
            }
        }
    }

    func testExplicitLowLevelRetryKeepsExistingCommandSemantics() async throws {
        try await MainActor.run {
            let h = Harness(); defer { h.cleanup() }
            let first = try h.updater.commandStarted(manifestUrl: "http://local/manifest")
            XCTAssertThrowsError(try h.updater.commandStarted(manifestUrl: "http://local/manifest"))
            h.updater.commandSettled(first, error: FirmwareUpdaterError("timeout", "timeout"))
            let next = try h.updater.commandStarted(manifestUrl: "http://local/manifest")
            XCTAssertNotEqual(first, next)
            h.updater.commandSettled(first, error: nil)
            XCTAssertEqual(h.updater.snapshot.phase, "preparing")
        }
    }
}
