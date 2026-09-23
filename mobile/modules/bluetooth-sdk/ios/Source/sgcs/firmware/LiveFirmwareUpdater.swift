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
    private var statusQuery: (id: String, revision: Int)?
    private var terminalRevision: Int?
    private var needsInspection = false
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

    func reconcileCompletion(_ evidence: FirmwareCompletionEvidence) throws -> FirmwareUpdateSnapshot {
        guard ["live-bes-reboot", "live-apk-build-increase", "live-apk-target-convergence"].contains(evidence.kind),
              evidence.deviceId == snapshot.deviceId, evidence.updaterId == snapshot.updaterId,
              !evidence.sessionId.isEmpty, evidence.sessionId == snapshot.sessionId,
              evidence.connectionGeneration == snapshot.connectionGeneration, evidence.revision == snapshot.revision
        else {
            throw FirmwareUpdaterError("stale_evidence", "The Live completion belongs to another transaction or observation")
        }
        guard connected(), commandToken == nil else { throw FirmwareUpdaterError("busy", "Wait for the current Live command and connection") }
        if snapshot.safeToRelease { return snapshot }
        guard let journal, let record else { throw FirmwareUpdaterError("invalid_journal", "The Live recovery record is unavailable") }
        var next = snapshot
        next.phase = "complete"; next.safeToRelease = true; next.canReconcile = false; next.progress = 1; next.error = nil
        // Commit the terminal recovery record before releasing native ownership.
        try journal.write(.init(snapshot: next, request: record))
        state.update { $0 = next }
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
        next.inventory.removeValue(forKey: "activeGlassesSessionId")
        // Never persist URLs, credentials or multi-pass approval. A saved record only authorizes inspection.
        try journal.write(.init(snapshot: next, request: evidence))
        record = evidence
        statusQuery = nil
        terminalRevision = nil; needsInspection = false
        let token = UUID(); commandToken = token
        state.update { $0 = next }
        commandRevision = snapshot.revision
        return token
    }

    func commandSettled(_ token: UUID, error: Error?) {
        guard commandToken == token else { return }
        commandToken = nil
        if terminalRevision == snapshot.revision {
            state.update { $0.safeToRelease = true; $0.canReconcile = false }
        } else if snapshot.revision == commandRevision {
            state.update {
                $0.phase = error == nil ? "installing" : "interrupted"
                $0.error = error == nil ? nil : "The OTA start outcome requires a glasses status query"
            }
        }
        terminalRevision = nil
        persist()
        if needsInspection { query() }
    }

    /// Correlate ASG's existing read-only activity diagnostics with this exact observation.
    func beginStatusQuery() -> String {
        let id = UUID().uuidString
        statusQuery = (id, snapshot.revision)
        return id
    }

    private func confirmsQuiescence(_ activity: [String: Any]?) -> Bool {
        guard let query = statusQuery, let activity,
              activity["request_id"] as? String == query.id else { return false }
        statusQuery = nil
        guard commandToken == nil, query.revision == snapshot.revision,
              let session = activity["session"] as? [String: Any],
              let status = session["status"] as? String,
              ["idle", "complete", "failed"].contains(status),
              let schema = activity["schema"] as? NSNumber,
              CFGetTypeID(schema) != CFBooleanGetTypeID(), schema.doubleValue == 1 else { return false }
        func flag(_ values: [String: Any], _ key: String, _ expected: Bool) -> Bool {
            guard let value = values[key] as? NSNumber,
                  CFGetTypeID(value) == CFBooleanGetTypeID() else { return false }
            return value.boolValue == expected
        }
        return flag(activity, "consistent", true) && flag(activity, "admission_held", false) &&
            flag(activity, "updating", false) && flag(activity, "mtk_in_progress", false) &&
            flag(activity, "bes_in_progress", false) && flag(session, "restart_pending", false)
    }

    func activity(_ activity: [String: Any], generation: Int) -> Bool {
        ownsDevice && status(sessionId: "", phase: "download", status: "idle", progress: 0, generation: generation, activity: activity)
    }

    @discardableResult
    func status(sessionId: String, phase: String, status: String, progress: Int, generation: Int,
                activity: [String: Any]? = nil, legacyEvent: Bool = false) -> Bool
    {
        guard generation == snapshot.connectionGeneration else { return false }
        // Idle only means ASG has no session to report. It can still be fetching
        // an acknowledged Start's manifest, including after this phone restarts.
        // Owned work needs terminal/completion proof or a correlated quiet-worker snapshot.
        if status == "idle", ownsDevice, !confirmsQuiescence(activity) { return false }
        let terminal = ["idle", "complete", "failed"].contains(status)
        if terminal, status != "idle", ownsDevice,
           (!legacyEvent && snapshot.inventory["activeGlassesSessionId"] != sessionId) ||
           (activity != nil && !confirmsQuiescence(activity))
        {
            // ASG can retain the previous terminal session while fetching this Start's manifest.
            // Legacy progress events are transient; modern cached status needs attempt binding.
            needsInspection = true
            if commandToken == nil, statusQuery == nil { query() }
            return false
        }
        needsInspection = false
        let safe = terminal && commandToken == nil
        if !safe, record == nil {
            // A glasses-owned update can predate this phone process. Persist observation only,
            // even when this updater did not send its Start command.
            record = FirmwareStartRequest(deviceId: snapshot.deviceId, connectionGeneration: generation,
                                          offerId: "observed-" + UUID().uuidString, kind: "live-observation")
        }
        state.update {
            if !safe, $0.sessionId == nil { $0.sessionId = UUID().uuidString; $0.offerId = record?.offerId }
            if !sessionId.isEmpty { $0.inventory["glassesSessionId"] = sessionId }
            if !terminal { $0.inventory["activeGlassesSessionId"] = sessionId }
            $0.phase = status == "idle" ? "idle" : status == "complete" ? "complete" : status == "failed" ? "failed" : phase == "download" ? "transferring" : "installing"
            $0.safeToRelease = safe; $0.canReconcile = !safe
            $0.progress = Double(max(0, min(100, progress))) / 100
            $0.error = status == "failed" ? "The glasses reported an update failure" : nil
        }
        terminalRevision = terminal && !safe ? snapshot.revision : nil
        persist()
        return true
    }

    func connectionChanged(generation: Int, disconnected: Bool = false) {
        terminalRevision = nil
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
