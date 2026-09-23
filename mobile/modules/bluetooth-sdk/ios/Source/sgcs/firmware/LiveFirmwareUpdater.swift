import CryptoKit
import Foundation

/// Native observation of Live's glasses-owned transaction. The Engine coordinator still
/// owns release selection, ACK/query arbitration, legacy reboot verification and chaining.
@MainActor
final class LiveFirmwareUpdater: FirmwareUpdater {
    private let state: FirmwareSessionState
    private let journal: FirmwareJournal?
    private let connected: () -> Bool
    private let query: () -> Void
    private var record: FirmwareStartRequest?
    private var commandToken: UUID?
    private var commandRevision = 0
    var launch: ((FirmwareStartRequest) throws -> Void)?
    var snapshot: FirmwareUpdateSnapshot {
        state.snapshot
    }

    init(deviceId: String, generation: Int, connected: @escaping () -> Bool,
         query: @escaping () -> Void, directory: URL? = nil)
    {
        self.connected = connected; self.query = query
        state = FirmwareSessionState(.init(integrationId: "mentra-live", deviceId: deviceId, connectionGeneration: generation))
        journal = try? FirmwareJournal(deviceId: deviceId, directory: directory)
        do {
            guard let journal else { throw FirmwareUpdaterError("invalid_journal", "Firmware recovery storage is unavailable") }
            if let saved = try journal.read() {
                guard saved.snapshot.integrationId == "mentra-live", saved.request.kind == "live-observation" else {
                    throw FirmwareUpdaterError("invalid_journal", "The recovery record belongs to another updater")
                }
                record = saved.request
                state.update {
                    let updaterId = $0.updaterId
                    $0 = saved.snapshot; $0.updaterId = updaterId; $0.revision = 0; $0.connectionGeneration = generation
                    if !$0.safeToRelease { $0.phase = "interrupted"; $0.canReconcile = true }
                }
            }
        } catch {
            state.update {
                $0.phase = "interrupted"; $0.safeToRelease = false; $0.canReconcile = true
                $0.error = "Firmware recovery information requires a fresh glasses status"
            }
        }
    }

    func observe(_ listener: @escaping (FirmwareUpdateSnapshot) -> Void) -> () -> Void {
        state.observe(listener)
    }

    func start(_ request: FirmwareStartRequest) throws -> FirmwareUpdateSnapshot {
        try validate(request)
        if request.offerId == snapshot.offerId, !snapshot.safeToRelease { return snapshot }
        guard snapshot.safeToRelease, commandToken == nil else { throw FirmwareUpdaterError("busy", "A Live update is awaiting reconciliation") }
        guard let launch else { throw FirmwareUpdaterError("unavailable", "Open the updater through the Bluetooth SDK") }
        // The SDK reserves its existing PendingResponse synchronously before the BLE handoff.
        try launch(request)
        return snapshot
    }

    func reconcile() throws -> FirmwareUpdateSnapshot {
        guard connected() else { throw FirmwareUpdaterError("disconnected", "Reconnect the same glasses to inspect the update") }
        query()
        return snapshot
    }

    func cancel() throws -> FirmwareUpdateSnapshot {
        throw FirmwareUpdaterError("action_unavailable", "Live's active transaction must be reconciled with the glasses")
    }

    func acknowledge() throws -> FirmwareUpdateSnapshot {
        guard snapshot.safeToRelease, commandToken == nil else { throw FirmwareUpdaterError("busy", "The Live update still owns the glasses") }
        try journal?.remove(); record = nil
        state.update {
            $0.sessionId = nil; $0.offerId = nil; $0.phase = "idle"; $0.progress = nil
            $0.error = nil; $0.canReconcile = false
        }
        return snapshot
    }

    /// Called by the established native PendingResponse path before any ota_start bytes.
    /// Explicit low-level retries retain their existing semantics; managed Start uses start().
    func commandStarted(manifestUrl: String, request: FirmwareStartRequest? = nil) throws -> UUID {
        guard commandToken == nil else { throw FirmwareUpdaterError("request_in_flight", "An OTA start command is already pending") }
        guard connected() else { throw FirmwareUpdaterError("disconnected", "The intended Live glasses are not connected") }
        if let request { try validate(request) }
        guard let journal else { throw FirmwareUpdaterError("invalid_journal", "Firmware recovery storage is unavailable") }
        let digest = SHA256.hash(data: Data(manifestUrl.utf8)).map { String(format: "%02x", $0) }.joined()
        let offerId = request?.offerId ?? digest
        let evidence = FirmwareStartRequest(deviceId: snapshot.deviceId, connectionGeneration: snapshot.connectionGeneration,
                                            offerId: offerId, kind: "live-observation", metadata: ["manifestSha256": digest])
        var next = snapshot
        next.sessionId = UUID().uuidString; next.offerId = offerId; next.phase = "preparing"
        next.safeToRelease = false; next.canReconcile = true; next.error = nil; next.progress = nil
        // Never persist URLs, credentials or multi-pass approval. A saved record only authorizes inspection.
        try journal.write(.init(snapshot: next, request: evidence))
        record = evidence
        let token = UUID(); commandToken = token
        state.update { $0 = next }
        commandRevision = snapshot.revision
        return token
    }

    func commandSettled(_ token: UUID, error: Error?) {
        guard commandToken == token else { return }
        commandToken = nil
        if snapshot.revision == commandRevision {
            state.update {
                $0.phase = error == nil ? "installing" : "interrupted"
                $0.error = error == nil ? nil : "The OTA start outcome requires a glasses status query"
            }
        }
        persist()
    }

    func status(sessionId: String, phase: String, status: String, progress: Int, generation: Int) {
        guard generation == snapshot.connectionGeneration else { return }
        if status == "idle", commandToken != nil { return }
        let safe = ["idle", "complete", "failed"].contains(status)
        if !safe, record == nil {
            // A glasses-owned update can predate this phone process. Persist observation only,
            // even when this updater did not send its Start command.
            record = FirmwareStartRequest(deviceId: snapshot.deviceId, connectionGeneration: generation,
                                          offerId: "observed-" + UUID().uuidString, kind: "live-observation")
        }
        state.update {
            if !safe, $0.sessionId == nil { $0.sessionId = UUID().uuidString; $0.offerId = record?.offerId }
            if !sessionId.isEmpty { $0.inventory["glassesSessionId"] = sessionId }
            $0.phase = status == "idle" ? "idle" : status == "complete" ? "complete" : status == "failed" ? "failed" : phase == "download" ? "transferring" : "installing"
            $0.safeToRelease = safe; $0.canReconcile = !safe
            $0.progress = Double(max(0, min(100, progress))) / 100
            $0.error = status == "failed" ? "The glasses reported an update failure" : nil
        }
        persist()
    }

    func connectionChanged(generation: Int, disconnected: Bool = false) {
        state.update {
            $0.connectionGeneration = generation
            if disconnected, !$0.safeToRelease { $0.phase = "interrupted"; $0.canReconcile = true }
        }
        persist()
    }

    var ownsDevice: Bool {
        commandToken != nil || !snapshot.safeToRelease
    }

    private func validate(_ request: FirmwareStartRequest) throws {
        guard request.deviceId == snapshot.deviceId, request.connectionGeneration == snapshot.connectionGeneration else {
            throw FirmwareUpdaterError("stale_offer", "The Live device or connection changed")
        }
        guard request.kind == "manifest", request.manifestUrl?.isEmpty == false, !request.offerId.isEmpty else {
            throw FirmwareUpdaterError("invalid_request", "Live requires an approved manifest request")
        }
    }

    private func persist() {
        guard let record else { return }
        do { try journal?.write(.init(snapshot: snapshot, request: record)) }
        catch { Bridge.log("Live firmware recovery record could not be saved") }
    }
}
