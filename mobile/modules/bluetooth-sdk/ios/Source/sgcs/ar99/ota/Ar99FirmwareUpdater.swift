import CryptoKit
import Foundation

/// Session ownership around the existing AR99 wire manager. It never invents a reset or resume offset.
@MainActor
final class Ar99FirmwareUpdater: FirmwareUpdater {
    struct Ports {
        var connected: () -> Bool
        var start: (Data, Ar99OtaCallbacks) -> Bool
        var queryInventory: () -> Void
        var reconnect: () -> Void = {}
    }

    private let state: FirmwareSessionState
    private let ports: Ports
    private var journal: FirmwareJournal?
    private var request: FirmwareStartRequest?
    private var operation = 0
    private var entered = false
    private(set) var legacyActive = false
    var ownsDevice: Bool {
        legacyActive || !snapshot.safeToRelease
    }

    var snapshot: FirmwareUpdateSnapshot {
        state.snapshot
    }

    init(deviceId: String, connectionGeneration: Int, ports: Ports, journalDirectory: URL? = nil) {
        self.ports = ports
        state = FirmwareSessionState(.init(integrationId: "ar99", deviceId: deviceId, connectionGeneration: connectionGeneration))
        do {
            let journal = try FirmwareJournal(deviceId: deviceId, directory: journalDirectory)
            self.journal = journal
            if let record = try journal.read() {
                guard record.snapshot.integrationId == "ar99", record.request.kind == "file" else {
                    throw FirmwareUpdaterError("invalid_journal", "AR99 recovery identity is invalid")
                }
                request = record.request
                state.update {
                    let updaterId = $0.updaterId
                    $0 = record.snapshot; $0.updaterId = updaterId; $0.connectionGeneration = connectionGeneration
                    if !$0.safeToRelease {
                        $0.phase = "interrupted"; $0.canReconcile = true; $0.canCancel = false
                        $0.error = "The previous AR99 transfer requires inspection; in-memory resume is unavailable after process restart"
                    }
                }
            }
        } catch {
            state.update { $0.phase = "interrupted"; $0.safeToRelease = false; $0.error = "AR99 recovery information is unavailable" }
        }
    }

    func observe(_ listener: @escaping (FirmwareUpdateSnapshot) -> Void) -> () -> Void {
        state.observe(listener)
    }

    func start(_ request: FirmwareStartRequest) throws -> FirmwareUpdateSnapshot {
        guard request.deviceId == snapshot.deviceId else { throw FirmwareUpdaterError("wrong_device", "AR99 target changed") }
        if ownsDevice || snapshot.sessionId != nil {
            if !legacyActive, request.offerId == snapshot.offerId, !snapshot.safeToRelease { return snapshot }
            throw FirmwareUpdaterError("busy", "An AR99 update already owns this device or awaits acknowledgement")
        }
        guard ports.connected(), request.connectionGeneration == snapshot.connectionGeneration else {
            throw FirmwareUpdaterError("stale_offer", "AR99 connection changed; check again")
        }
        guard request.kind == "file", !request.offerId.isEmpty, let artifact = request.artifact,
              !artifact.targetVersion.isEmpty, let size = artifact.size, size > 0, size <= 64 * 1024 * 1024,
              let hash = artifact.sha256, hash.count == 64, hash.allSatisfy({ $0.isASCII && $0.isHexDigit }), let journal
        else {
            throw FirmwareUpdaterError("invalid_artifact", "AR99 requires a prepared firmware file and its byte identity")
        }
        self.request = request; entered = false; operation += 1
        let admitted = operation
        state.update {
            $0.sessionId = UUID().uuidString; $0.offerId = request.offerId; $0.phase = "preparing"
            $0.targetFirmware = artifact.targetVersion; $0.safeToRelease = false; $0.error = nil; $0.canReconcile = false
        }
        do {
            let url = artifact.path.hasPrefix("file://") ? URL(string: artifact.path) : URL(fileURLWithPath: artifact.path)
            guard let url, url.isFileURL, url.path.hasPrefix("/") else { throw FirmwareUpdaterError("invalid_artifact", "AR99 firmware must be a local file") }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var bytes = Data()
            while bytes.count < size {
                guard let chunk = try handle.read(upToCount: min(65536, size - bytes.count)), !chunk.isEmpty else {
                    throw FirmwareUpdaterError("invalid_artifact", "AR99 firmware file was truncated")
                }
                bytes.append(chunk)
            }
            guard try handle.read(upToCount: 1)?.isEmpty != false,
                  SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == hash.lowercased()
            else {
                throw FirmwareUpdaterError("invalid_artifact", "AR99 firmware bytes changed after approval")
            }
            // No URLs, credentials or cached approval can authorize a future cold start.
            self.request = FirmwareStartRequest(deviceId: request.deviceId, connectionGeneration: request.connectionGeneration,
                                                offerId: request.offerId, kind: "file", artifact: artifact)
            try journal.write(.init(snapshot: snapshot, request: self.request!))
            entered = true
            let accepted = ports.start(bytes, Ar99OtaCallbacks(
                onProgress: { [weak self] offset, total, progress in self?.transition(admitted, phase: "transferring", progress: progress, offset: offset, total: total) },
                onCompleted: { [weak self] needsReboot in
                    guard let self, self.operation == admitted else { return }
                    self.state.update { $0.inventory["activation"] = "unverified"; $0.inventory["needsReboot"] = String(needsReboot) }
                    self.transition(admitted, phase: "complete", progress: 100, safe: true)
                    self.ports.queryInventory()
                },
                onError: { [weak self] _, message in self?.transition(admitted, phase: "interrupted", error: message) },
                onCancelled: { [weak self] in self?.transition(admitted, phase: "interrupted", error: "The local AR99 transfer stopped; device recovery has not been verified") },
                onPausedWaitingReconnect: { [weak self] in self?.transition(admitted, phase: "paused") }
            ))
            if !accepted, snapshot.phase != "complete" {
                // No transfer accepted by the manager; no upgrade request was sent.
                entered = false
                transition(admitted, phase: "failed", safe: true, error: "AR99 could not prepare its OTA channel")
            }
        } catch {
            transition(admitted, phase: entered ? "interrupted" : "failed", safe: !entered, error: error.localizedDescription)
        }
        return snapshot
    }

    func reconcile() throws -> FirmwareUpdateSnapshot {
        guard ports.connected() else { ports.reconnect(); return snapshot }
        ports.queryInventory() // Never call start/cancel or guess an offset here.
        return snapshot
    }

    func cancel() throws -> FirmwareUpdateSnapshot {
        throw FirmwareUpdaterError("action_unavailable", "AR99 has no verified remote abort for a managed transfer")
    }

    func acknowledge() throws -> FirmwareUpdateSnapshot {
        guard !ownsDevice else { throw FirmwareUpdaterError("busy", "AR99 still requires update recovery") }
        try journal?.remove(); request = nil; operation += 1
        state.update { $0.sessionId = nil; $0.offerId = nil; $0.phase = "idle"; $0.progress = nil; $0.targetFirmware = nil; $0.error = nil; $0.canReconcile = false }
        return snapshot
    }

    func connectionChanged(generation: Int) {
        state.update { $0.connectionGeneration = generation }
    }

    func inventoryChanged(version: String, serial: String, projectName: String, generation: Int) {
        guard generation == snapshot.connectionGeneration else { return }
        state.update {
            $0.observedFirmware = version
            $0.inventory["serialNumber"] = serial; $0.inventory["projectName"] = projectName
            $0.inventory["revision"] = String((Int($0.inventory["revision"] ?? "0") ?? 0) + 1)
            if !version.isEmpty, version == $0.targetFirmware, ["interrupted", "complete"].contains($0.phase) {
                $0.phase = "complete"; $0.safeToRelease = true; $0.canReconcile = false; $0.error = nil
                $0.inventory["activation"] = "verified"
            }
        }
        persist()
    }

    /// Existing SDK clients retain their explicit restart/cancel behavior, but cannot replace managed work.
    func beginLegacy() throws {
        guard snapshot.safeToRelease, snapshot.sessionId == nil else { throw FirmwareUpdaterError("busy", "The managed AR99 update owns this device") }
        legacyActive = true
    }

    func endLegacy() {
        legacyActive = false
    }

    func assertLegacyControlAllowed() throws {
        guard snapshot.safeToRelease, snapshot.sessionId == nil else { throw FirmwareUpdaterError("busy", "The managed AR99 update owns this device") }
    }

    private func transition(_ admitted: Int, phase: String, progress: Int? = nil, offset: Int? = nil, total: Int? = nil, safe: Bool = false, error: String? = nil) {
        guard operation == admitted else { return }
        state.update {
            $0.phase = phase; $0.safeToRelease = safe; $0.error = error; $0.canReconcile = phase == "interrupted"
            if let progress { $0.progress = Double(min(100, max(0, progress))) / 100 }
            if let offset { $0.inventory["offset"] = String(offset) }
            if let total { $0.inventory["total"] = String(total) }
        }
        persist()
    }

    private func persist() {
        guard let request, let journal else { return }
        do { try journal.write(.init(snapshot: snapshot, request: request, recoveryStage: snapshot.inventory["activation"])) }
        catch { state.update { $0.error = "AR99 recovery record could not be saved" } }
    }
}
