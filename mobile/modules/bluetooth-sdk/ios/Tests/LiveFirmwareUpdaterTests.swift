import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class LiveFirmwareUpdaterTests: XCTestCase {
    @MainActor
    private final class Harness {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        var writes = 0
        var queries = 0
        var token: UUID?
        let request = FirmwareStartRequest(deviceId: "live", connectionGeneration: 1, offerId: "offer", kind: "manifest",
                                           manifestUrl: "https://example.com/manifest?private=secret", metadata: ["authorization": "secret"])
        lazy var updater = makeUpdater()
        func makeUpdater() -> LiveFirmwareUpdater {
            let value = LiveFirmwareUpdater(deviceId: "live", generation: 1, connected: { true },
                                            query: { [unowned self] in queries += 1 }, directory: directory)
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
            XCTAssertTrue(recovered.snapshot.safeToRelease)
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
