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
        var inventoryCallbacks: [(Result<NimoOtaManager.Inventory, Error>) -> Void] = []
        var writes: [Data] = []
        var releases = 0
        var timers: [() -> Void] = []
        lazy var updater = makeUpdater()

        func makeUpdater(journalDirectory: URL? = nil) -> NimoFirmwareUpdater {
            NimoFirmwareUpdater(deviceId: "device", connectionGeneration: generation, ports: .init(
                connection: { [unowned self] in .init(deviceId: "device", generation: generation, writeCapacity: capacity) },
                prepare: { [unowned self] in prepareCallbacks.append($0) },
                release: { [unowned self] in releases += 1 },
                write: { [unowned self] data, done in writes.append(data); done(nil) },
                readInventory: { [unowned self] in inventoryCallbacks.append($0) },
                schedule: { [unowned self] _, callback in
                    var cancelled = false
                    timers.append { if !cancelled { callback() } }
                    return { cancelled = true }
                },
                now: { 0 }
            ), journalDirectory: journalDirectory ?? directory)
        }

        func reply(_ body: Data) {
            let sent = writes.last!
            let length = body.count + 2
            updater.receive(Data([0x70, 7, 0x6E, 0, sent[4], UInt8(length >> 8), UInt8(length & 255), 0, sent[7]]) + body + Data([0x33]), connectionGeneration: generation)
        }

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

    func testIdleReconnectAcceptsFreshInventoryBeforeOtaChannelPreparation() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            h.updater.inventoryChanged(.init(firmwareDetail: "old", packedVersion: "0.1.0.14"), connectionGeneration: 1)
            h.updater.disconnected(connectionGeneration: 1)
            h.generation = 2
            h.updater.connectionChanged(deviceId: "device", generation: 2)
            h.updater.inventoryChanged(.init(firmwareDetail: "fresh", packedVersion: "0.1.1.1"), connectionGeneration: 2)
            h.updater.inventoryChanged(.init(firmwareDetail: "stale", packedVersion: "0.1.0.14"), connectionGeneration: 1)
            XCTAssertEqual(h.updater.snapshot.observedFirmware, "fresh")
            XCTAssertEqual(h.updater.snapshot.inventory["revision"], "2")
            XCTAssertTrue(h.prepareCallbacks.isEmpty); XCTAssertTrue(h.writes.isEmpty)
            XCTAssertTrue(h.updater.snapshot.safeToRelease)
        }
    }

    func testUnavailableNewJournalDoesNotOwnAnUnmodifiedDevice() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            let blocked = h.directory.appendingPathComponent("blocked")
            try Data([1]).write(to: blocked)
            let updater = h.makeUpdater(journalDirectory: blocked)
            XCTAssertTrue(updater.snapshot.safeToRelease)
            let failed = try updater.start(h.request)
            XCTAssertEqual(failed.phase, "failed"); XCTAssertTrue(failed.safeToRelease)
            XCTAssertTrue(h.writes.isEmpty); XCTAssertTrue(h.prepareCallbacks.isEmpty)
            _ = try updater.acknowledge()
            XCTAssertTrue(h.makeUpdater(journalDirectory: blocked).snapshot.safeToRelease)
        }
    }

    func testDirectorySymlinkDoesNotHideExistingRecovery() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            var saved = FirmwareUpdateSnapshot(integrationId: "nimo", deviceId: "device", connectionGeneration: 1)
            saved.phase = "transferring"; saved.safeToRelease = false
            try FirmwareJournal(deviceId: "device", directory: h.directory).write(.init(snapshot: saved, request: h.request))
            let link = h.directory.appendingPathComponent("recovery-link")
            try FileManager.default.createSymbolicLink(at: link, withDestinationURL: h.directory)
            XCTAssertFalse(h.makeUpdater(journalDirectory: link).snapshot.safeToRelease)
        }
    }

    func testJournalRetainsOnlyRecoveryMetadata() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            var metadata = h.request.metadata
            metadata["authorization"] = "private-token"
            let request = FirmwareStartRequest(deviceId: "device", connectionGeneration: 1, offerId: "offer", kind: "file",
                                               artifact: h.request.artifact, manifestUrl: "https://example.com/?secret=private-token", metadata: metadata)
            _ = try h.updater.start(request)
            let saved = try FirmwareJournal(deviceId: "device", directory: h.directory).read()
            XCTAssertNil(saved?.request.manifestUrl)
            XCTAssertEqual(saved?.request.metadata, h.request.metadata)
            XCTAssertEqual(saved?.request.artifact?.sha256, h.request.artifact?.sha256)
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

    func testColdStartReleasesOnlyAttemptsProvenToPrecedeUpgradeEntry() async throws {
        try await MainActor.run {
            // Stop during preparation, INFO, FILE_OFFSET, CAN_UPDATE, or after ENTER is submitted.
            for stage in 0 ... 4 {
                let h = try Harness(); defer { h.cleanup() }
                _ = try h.updater.start(h.request)
                if stage >= 1 { h.capacity = 244; h.prepareCallbacks[0](nil) }
                if stage >= 2 { h.reply(Data([0x06, 0, 0, 0x0E, 0, 0x0E, 2, 5, 1, 0, 0, 2, 1, 3, 2, 0x64, 0x64, 2, 3, 1, 2, 4, 0, 2, 5, 1])) }
                if stage >= 3 { h.reply(Data([0, 0, 0, 0, 0, 18])) }
                if stage >= 4 { h.reply(Data([3])) }
                XCTAssertFalse(h.updater.snapshot.safeToRelease)
                let writes = h.writes.count
                let preparations = h.prepareCallbacks.count
                h.generation = 2
                let recovered = h.makeUpdater()
                XCTAssertEqual(recovered.snapshot.safeToRelease, stage < 4)
                XCTAssertEqual(recovered.snapshot.phase, stage < 4 ? "failed" : "interrupted")
                XCTAssertEqual(h.writes.count, writes); XCTAssertEqual(h.prepareCallbacks.count, preparations)
                if stage < 4 {
                    XCTAssertEqual(try recovered.acknowledge().phase, "idle")
                } else {
                    XCTAssertEqual(h.writes.last?[4], 0xE3)
                    XCTAssertThrowsError(try recovered.acknowledge())
                    XCTAssertThrowsError(try recovered.reconcile())
                }
                XCTAssertEqual(h.writes.count, writes) // Never retry or reset automatically.
            }
        }
    }

    func testOldPreparingJournalWithoutPreEntryProofRemainsUnsafe() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            var old = FirmwareUpdateSnapshot(integrationId: "nimo", deviceId: "device", connectionGeneration: 1)
            old.phase = "preparing"; old.safeToRelease = false; old.sessionId = "old-session"
            try FirmwareJournal(deviceId: "device", directory: h.directory).write(.init(snapshot: old, request: h.request))
            XCTAssertFalse(h.updater.snapshot.safeToRelease)
            XCTAssertThrowsError(try h.updater.acknowledge())
            XCTAssertTrue(h.writes.isEmpty)
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

    func testRecoveryRetryRebindsAfterPreparationFailsOnANewConnection() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            var interrupted = FirmwareUpdateSnapshot(integrationId: "nimo", deviceId: "device", connectionGeneration: 1)
            interrupted.phase = "interrupted"; interrupted.safeToRelease = false; interrupted.sessionId = "native-session"
            try FirmwareJournal(deviceId: "device", directory: h.directory).write(.init(snapshot: interrupted, request: h.request, recoveryStage: "synchronized"))
            _ = try h.updater.reconcile()
            h.prepareCallbacks[0](FirmwareUpdaterError("prepare", "not ready"))
            h.generation = 2
            h.updater.connected(.init(deviceId: "device", generation: 2, writeCapacity: 244))
            h.prepareCallbacks[1](FirmwareUpdaterError("prepare", "not ready yet"))
            _ = try h.updater.reconcile()
            h.capacity = 244; h.prepareCallbacks[2](nil)
            h.inventoryCallbacks.last?(.success(.init(firmwareDetail: "full-target", packedVersion: "0.1.1.1")))
            let sent = try XCTUnwrap(h.writes.last)
            let body = Data([0x06, 0, 0, 1, 0, 1, 2, 5, 1, 0, 0, 2, 1, 3, 2, 0x64, 0x64, 2, 3, 1, 2, 4, 0, 2, 5, 1])
            let length = body.count + 2
            let reply = Data([0x70, 7, 0x6E, 0, sent[4], UInt8(length >> 8), UInt8(length & 255), 0, sent[7]]) + body + Data([0x33])
            h.updater.receive(reply, connectionGeneration: 1)
            XCTAssertFalse(h.updater.snapshot.safeToRelease)
            h.updater.receive(reply, connectionGeneration: 2)
            XCTAssertEqual(h.updater.snapshot.phase, "complete")
            XCTAssertTrue(h.updater.snapshot.safeToRelease)
            XCTAssertEqual(h.writes.count, 1) // INFO only: no resumed ENTER or RESET.
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
