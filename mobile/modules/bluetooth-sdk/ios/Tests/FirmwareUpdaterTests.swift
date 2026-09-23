import CryptoKit
import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class FirmwareUpdaterTests: XCTestCase {
    @MainActor
    private final class Harness {
        let directory: URL
        let request: FirmwareStartRequest
        var generation = 1
        var capacity = 20
        var prepareCallbacks: [(Error?) -> Void] = []
        var writes: [Data] = []
        var releases = 0
        var timers: [() -> Void] = []
        lazy var updater = NimoFirmwareUpdater(deviceId: "device", connectionGeneration: generation, ports: .init(
            connection: { [unowned self] in .init(deviceId: "device", generation: generation, writeCapacity: capacity) },
            prepare: { [unowned self] in prepareCallbacks.append($0) },
            release: { [unowned self] in releases += 1 },
            write: { [unowned self] data, done in writes.append(data); done(nil) },
            readInventory: { _ in },
            schedule: { [unowned self] _, callback in
                var cancelled = false
                timers.append { if !cancelled { callback() } }
                return { cancelled = true }
            },
            now: { 0 }
        ), journalDirectory: directory)

        init() throws {
            directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = Data(repeating: 1, count: 1024)
            let path = directory.appendingPathComponent("image.bin")
            try data.write(to: path)
            let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            request = .init(deviceId: "device", connectionGeneration: 1, offerId: "offer", kind: "file",
                            artifact: .init(path: path.path, targetVersion: "full-target", size: 1024, sha256: hash),
                            metadata: ["hardwareId": "00000201", "packedVersion": "0.1.1.1", "peerVersion": "0001"])
        }

        func cleanup() {
            try? FileManager.default.removeItem(at: directory)
        }
    }

    func testAdmissionPrecedesPreparationAndUsesItsNegotiatedWriteLimit() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            let first = try h.updater.start(h.request)
            XCTAssertFalse(first.safeToRelease)
            XCTAssertEqual(first.phase, "preparing")
            XCTAssertEqual(try h.updater.start(h.request).sessionId, first.sessionId)
            var observed: [Int] = []
            let unsubscribe = h.updater.observe { observed.append($0.revision) }
            unsubscribe()
            XCTAssertEqual(h.prepareCallbacks.count, 1)
            XCTAssertTrue(h.writes.isEmpty)
            XCTAssertThrowsError(try h.updater.acknowledge())
            h.capacity = 244
            h.prepareCallbacks[0](nil)
            XCTAssertEqual(h.writes.count, 1)
            XCTAssertEqual(h.writes[0][4], 2)
            XCTAssertEqual(h.releases, 0)
            XCTAssertEqual(observed.count, 1)
        }
    }

    func testLatePreparationCannotStartAfterTimeoutOrDeviceReconnect() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            _ = try h.updater.start(h.request)
            h.timers[0]()
            XCTAssertEqual(h.updater.snapshot.phase, "failed")
            XCTAssertTrue(h.updater.snapshot.safeToRelease)
            h.capacity = 244; h.prepareCallbacks[0](nil)
            XCTAssertTrue(h.writes.isEmpty); XCTAssertEqual(h.releases, 1)
            _ = try h.updater.acknowledge()
            _ = try h.updater.start(h.request)
            h.generation = 2
            h.prepareCallbacks[1](nil)
            XCTAssertTrue(h.writes.isEmpty); XCTAssertTrue(h.updater.snapshot.safeToRelease)
        }
    }

    func testCorruptJournalCannotAuthorizeStartOrAcknowledgement() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            let name = SHA256.hash(data: Data("device".utf8)).map { String(format: "%02x", $0) }.joined() + ".json"
            try Data("broken".utf8).write(to: h.directory.appendingPathComponent(name))
            XCTAssertFalse(h.updater.snapshot.safeToRelease)
            XCTAssertThrowsError(try h.updater.start(h.request))
            XCTAssertThrowsError(try h.updater.acknowledge())
            XCTAssertTrue(h.writes.isEmpty)
        }
    }

    func testColdRecoveryRetainsSyncEvidenceButDoesNotReplayFlash() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            var interrupted = FirmwareUpdateSnapshot(integrationId: "nimo", deviceId: "device", connectionGeneration: 0)
            interrupted.phase = "interrupted"; interrupted.safeToRelease = false; interrupted.sessionId = "native-session"
            let journal = try FirmwareJournal(deviceId: "device", directory: h.directory)
            try journal.write(.init(snapshot: interrupted, request: h.request, recoveryStage: "synchronized"))
            XCTAssertTrue(h.updater.snapshot.canReconcile)
            XCTAssertTrue(h.writes.isEmpty); XCTAssertTrue(h.prepareCallbacks.isEmpty)
            _ = try h.updater.reconcile()
            XCTAssertEqual(h.prepareCallbacks.count, 1)
            h.capacity = 244; h.prepareCallbacks[0](nil)
            XCTAssertEqual(h.updater.snapshot.phase, "verifying")
            XCTAssertTrue(h.writes.isEmpty) // Inventory callback, never ENTER or RESET.
        }
    }

    func testObserversAreOrderedAcrossReentrantPublication() async {
        await MainActor.run {
            let state = FirmwareSessionState(.init(integrationId: "test", deviceId: "device", connectionGeneration: 1), publish: { _ in })
            var revisions: [Int] = []
            var second: [Int] = []
            let unsubscribe = state.observe { snapshot in
                revisions.append(snapshot.revision)
                if snapshot.revision == 1 {
                    state.update { $0.phase = "complete" }
                    _ = state.observe { second.append($0.revision) }
                }
            }
            state.update { $0.phase = "preparing" }
            unsubscribe()
            XCTAssertEqual(revisions, [0, 1, 2])
            XCTAssertEqual(second, [2])
        }
    }
}
