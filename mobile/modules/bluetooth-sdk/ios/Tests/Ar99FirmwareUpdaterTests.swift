import CryptoKit
import Foundation
@testable import MentraBluetoothSDK
import XCTest

final class Ar99FirmwareUpdaterTests: XCTestCase {
    @MainActor private final class Harness {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let file: URL
        let request: FirmwareStartRequest
        var callbacks: Ar99OtaCallbacks?
        var starts = 0
        var queries = 0
        var onStart: (() -> Void)?
        lazy var updater = makeUpdater()
        init() throws {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            file = directory.appendingPathComponent("image.bin")
            let bytes = Data([1, 2, 3]); try bytes.write(to: file)
            request = .init(deviceId: "ar99", connectionGeneration: 1, offerId: "offer", kind: "file",
                            artifact: .init(path: file.path, targetVersion: "new", size: bytes.count,
                                            sha256: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()))
        }

        func makeUpdater() -> Ar99FirmwareUpdater {
            Ar99FirmwareUpdater(deviceId: "ar99", connectionGeneration: 1, ports: .init(
                connected: { true }, start: { [unowned self] bytes, callback in
                    XCTAssertEqual(bytes, Data([1, 2, 3])); starts += 1; callbacks = callback; onStart?(); return true
                }, queryInventory: { [unowned self] in queries += 1 }
            ), journalDirectory: directory)
        }

        func cleanup() {
            try? FileManager.default.removeItem(at: directory)
        }
    }

    func testAdmitsBeforeManagerPreparationAndDuplicateStartAdopts() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            h.onStart = {
                XCTAssertFalse(h.updater.snapshot.safeToRelease)
                do {
                    let record = try FirmwareJournal(deviceId: "ar99", directory: h.directory).read()
                    XCTAssertNotNil(record)
                } catch { XCTFail("Admission was not journaled") }
                do { try h.updater.beginLegacy(); XCTFail("Legacy start replaced managed ownership") } catch {}
            }
            let admitted = try h.updater.start(h.request)
            XCTAssertEqual(try h.updater.start(h.request).sessionId, admitted.sessionId)
            XCTAssertEqual(h.starts, 1)
            XCTAssertThrowsError(try h.updater.cancel())
            XCTAssertThrowsError(try h.updater.acknowledge())
        }
    }

    func testLegacyPreparationCannotBeReplacedByManagedStart() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            try h.updater.beginLegacy()
            XCTAssertThrowsError(try h.updater.start(h.request))
            XCTAssertTrue(h.updater.ownsDevice); XCTAssertEqual(h.starts, 0)
            h.updater.endLegacy()
            _ = try h.updater.start(h.request)
            XCTAssertEqual(h.starts, 1)
        }
    }

    func testChangedFileFailsBeforeWireWork() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            try Data([4, 5, 6]).write(to: h.file)
            let result = try h.updater.start(h.request)
            XCTAssertEqual(h.starts, 0); XCTAssertEqual(result.phase, "failed"); XCTAssertTrue(result.safeToRelease)
        }
    }

    func testImageValidationDoesNotPretendTheTargetIsRunning() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            h.updater.inventoryChanged(version: "old", serial: "serial", projectName: "AR99", generation: 1)
            _ = try h.updater.start(h.request)
            let stale = h.callbacks!
            stale.onCompleted(false)
            XCTAssertEqual(h.updater.snapshot.observedFirmware, "old")
            XCTAssertEqual(h.updater.snapshot.inventory["activation"], "unverified")
            XCTAssertTrue(h.updater.snapshot.safeToRelease)
            _ = try h.updater.acknowledge()
            stale.onProgress(3, 3, 100)
            XCTAssertEqual(h.updater.snapshot.phase, "idle")
        }
    }

    func testPausedTransferAndColdRecoveryNeverRestartOrGuessOffsets() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            _ = try h.updater.start(h.request)
            h.callbacks?.onPausedWaitingReconnect()
            XCTAssertFalse(h.updater.snapshot.safeToRelease)
            _ = try h.updater.reconcile()
            let restored = h.makeUpdater()
            XCTAssertEqual(restored.snapshot.phase, "interrupted")
            XCTAssertFalse(restored.snapshot.safeToRelease)
            _ = try restored.reconcile()
            XCTAssertEqual(h.starts, 1); XCTAssertEqual(h.queries, 2)
            restored.connectionChanged(generation: 2)
            restored.inventoryChanged(version: "new", serial: "serial", projectName: "AR99", generation: 1)
            XCTAssertFalse(restored.snapshot.safeToRelease)
            restored.inventoryChanged(version: "new", serial: "serial", projectName: "AR99", generation: 2)
            XCTAssertTrue(restored.snapshot.safeToRelease)
            XCTAssertEqual(restored.snapshot.inventory["activation"], "verified")
        }
    }

    func testTimeoutDoesNotAuthorizeAnotherFlashOrDisconnect() async throws {
        try await MainActor.run {
            let h = try Harness(); defer { h.cleanup() }
            _ = try h.updater.start(h.request)
            h.callbacks?.onError(255, "OTA reconnect timed out")
            XCTAssertFalse(h.updater.snapshot.safeToRelease)
            XCTAssertThrowsError(try h.updater.acknowledge())
            XCTAssertThrowsError(try h.updater.beginLegacy())
            XCTAssertEqual(h.starts, 1)
        }
    }
}
