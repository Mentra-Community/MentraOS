import Foundation

/// Admits one native attempt before notification setup, retains its result, and binds recovery to its device.
@MainActor
final class NimoFirmwareUpdater: FirmwareUpdater {
    struct Connection {
        let deviceId: String
        let generation: Int
        let writeCapacity: Int
    }

    struct Ports {
        var connection: () -> Connection?
        /// Stop ordinary traffic, drain the existing queue, then enable the OTA channel.
        var prepare: (@escaping (Error?) -> Void) -> Void
        var release: () -> Void
        var write: (Data, @escaping (Error?) -> Void) -> Void
        var readInventory: (@escaping (Result<NimoOtaManager.Inventory, Error>) -> Void) -> Void
        var schedule: (TimeInterval, @escaping () -> Void) -> (() -> Void)
        var now: () -> TimeInterval
        var isCompatible: (String, String) -> Bool = { _, _ in false }
        var configureCompatibility: ([String: String]) throws -> Void = { _ in
            throw FirmwareUpdaterError("unsupported", "NIMO compatibility policy is unavailable")
        }
    }

    private let state: FirmwareSessionState
    private let ports: Ports
    private var journal: FirmwareJournal?
    private var request: FirmwareStartRequest?
    private var manager: NimoOtaManager?
    private var owned = false
    private var operation = 0
    private var preparing = false
    private var preparationGeneration = 0
    private var cancelPrepare: (() -> Void)?
    private var rebootEvidence = false

    var snapshot: FirmwareUpdateSnapshot {
        state.snapshot
    }

    init(deviceId: String, connectionGeneration: Int, ports: Ports, journalDirectory: URL? = nil) {
        self.ports = ports
        state = FirmwareSessionState(.init(integrationId: "nimo", deviceId: deviceId, connectionGeneration: connectionGeneration))
        do {
            let journal = try FirmwareJournal(deviceId: deviceId, directory: journalDirectory)
            self.journal = journal
            if let record = try journal.read() {
                guard record.snapshot.integrationId == "nimo", record.request.kind == "file" else {
                    throw FirmwareUpdaterError("invalid_journal", "Recovery record belongs to another updater")
                }
                request = record.request
                rebootEvidence = record.recoveryStage == "synchronized" || ["restarting", "verifying", "complete"].contains(record.snapshot.phase)
                state.update {
                    let updaterId = $0.updaterId
                    $0 = record.snapshot
                    $0.updaterId = updaterId
                    $0.connectionGeneration = connectionGeneration
                    if !$0.safeToRelease {
                        $0.phase = "interrupted"
                        $0.error = "A previous firmware update requires device inspection"
                        $0.canReconcile = rebootEvidence
                    }
                }
            }
        } catch {
            state.update {
                $0.phase = "interrupted"; $0.safeToRelease = false
                $0.error = "Firmware recovery information is unavailable: \(error.localizedDescription)"
            }
        }
    }

    func observe(_ listener: @escaping (FirmwareUpdateSnapshot) -> Void) -> () -> Void {
        state.observe(listener)
    }

    func configure(_ metadata: [String: String]) throws -> FirmwareUpdateSnapshot {
        guard snapshot.safeToRelease, !preparing else { throw FirmwareUpdaterError("busy", "The active NIMO update owns its policy") }
        _ = try connected()
        try ports.configureCompatibility(metadata)
        state.update {
            $0.inventory["compatible"] = ports.isCompatible($0.observedFirmware ?? "", $0.inventory["packedVersion"] ?? "") ? "true" : "false"
        }
        return snapshot
    }

    func start(_ request: FirmwareStartRequest) throws -> FirmwareUpdateSnapshot {
        guard request.deviceId == snapshot.deviceId else { throw FirmwareUpdaterError("wrong_device", "The update belongs to another device") }
        if snapshot.sessionId != nil || !snapshot.safeToRelease {
            if request.offerId == snapshot.offerId, !snapshot.safeToRelease { return snapshot }
            throw FirmwareUpdaterError("busy", "A previous update still owns this device or awaits acknowledgement")
        }
        let connection = try connected()
        guard request.connectionGeneration == connection.generation else { throw FirmwareUpdaterError("stale_offer", "The device reconnected; check the update again") }
        guard !request.offerId.isEmpty, request.kind == "file", let artifact = request.artifact,
              let size = artifact.size, size > 0, size <= 32 * 1024 * 1024
        else {
            throw FirmwareUpdaterError("invalid_artifact", "NIMO requires a bounded, verified firmware file")
        }
        let target = try target(from: request)
        guard let journal else { throw FirmwareUpdaterError("invalid_journal", "Firmware recovery storage is unavailable") }
        // Admit before reading the file or changing any native notification/traffic state.
        let recoveryRequest = FirmwareStartRequest(
            deviceId: request.deviceId, connectionGeneration: request.connectionGeneration,
            offerId: request.offerId, kind: "file", artifact: artifact,
            metadata: request.metadata.filter { ["hardwareId", "packedVersion", "peerVersion"].contains($0.key) }
        )
        self.request = recoveryRequest
        operation += 1
        state.update {
            $0.sessionId = UUID().uuidString; $0.offerId = request.offerId; $0.phase = "preparing"
            $0.safeToRelease = false; $0.targetFirmware = target.firmwareDetail; $0.error = nil
        }
        do {
            let url = artifact.path.hasPrefix("file://") ? URL(string: artifact.path) : URL(fileURLWithPath: artifact.path)
            guard let url, url.isFileURL, url.path.hasPrefix("/") else { throw FirmwareUpdaterError("invalid_artifact", "Firmware must be a local file") }
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard (attributes[.size] as? NSNumber)?.intValue == size else { throw FirmwareUpdaterError("invalid_artifact", "Firmware file size changed") }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            var firmware = Data()
            while firmware.count < size {
                guard let bytes = try handle.read(upToCount: min(65536, size - firmware.count)), !bytes.isEmpty else {
                    throw FirmwareUpdaterError("invalid_artifact", "Firmware file was truncated")
                }
                firmware.append(bytes)
            }
            guard try handle.read(upToCount: 1)?.isEmpty != false else {
                throw FirmwareUpdaterError("invalid_artifact", "Firmware file grew after validation")
            }
            // Preserve admitted identity before any native preparation. Manager rechecks actual bytes before entry.
            try journal.write(.init(snapshot: snapshot, request: recoveryRequest))
            prepare { [weak self] in
                guard let self, let ready = self.ports.connection() else { return }
                self.manager = self.makeManager(firmware: firmware, target: target, connection: ready)
                self.manager?.start()
            }
        } catch { preparationFailed(error) }
        return snapshot
    }

    func reconcile() throws -> FirmwareUpdateSnapshot {
        let connection = try connected()
        if snapshot.phase == "idle" || snapshot.safeToRelease {
            ports.readInventory { [weak self] result in
                guard let self, self.ports.connection()?.generation == connection.generation else { return }
                if case let .success(inventory) = result { self.inventoryChanged(inventory, connectionGeneration: connection.generation) }
            }
            return snapshot
        }
        guard !preparing else { return snapshot }
        guard snapshot.phase == "interrupted" else { return snapshot }
        guard rebootEvidence else { throw FirmwareUpdaterError("recovery_required", "Interrupted transfer recovery must be confirmed with NIMO; no reset was sent") }
        if manager == nil {
            guard let request else { throw FirmwareUpdaterError("invalid_journal", "The update target is unavailable") }
            manager = try makeManager(firmware: Data(), target: target(from: request), connection: connection, recoveringReboot: true)
        }
        prepare { [weak self] in self?.manager?.reconcileAfterReboot() }
        return snapshot
    }

    func cancel() throws -> FirmwareUpdateSnapshot {
        throw FirmwareUpdaterError("action_unavailable", "NIMO has no verified safe abort command")
    }

    func acknowledge() throws -> FirmwareUpdateSnapshot {
        guard snapshot.safeToRelease, !preparing else { throw FirmwareUpdaterError("busy", "The glasses still require update recovery") }
        try journal?.remove()
        operation += 1; manager = nil; request = nil; rebootEvidence = false
        state.update {
            $0.sessionId = nil; $0.offerId = nil; $0.phase = "idle"; $0.progress = nil
            $0.targetFirmware = nil; $0.error = nil; $0.canReconcile = false
        }
        return snapshot
    }

    func receive(_ data: Data, connectionGeneration: Int) {
        manager?.receive(data, connectionGeneration: connectionGeneration)
    }

    func disconnected(connectionGeneration: Int) {
        guard snapshot.connectionGeneration == connectionGeneration else { return }
        if preparing { preparationFailed(FirmwareUpdaterError("disconnected", "Device disconnected during OTA preparation")) }
        manager?.disconnected(connectionGeneration: connectionGeneration)
    }

    func connected(_ connection: Connection) {
        guard connection.deviceId == snapshot.deviceId else { return }
        connectionChanged(deviceId: connection.deviceId, generation: connection.generation)
        if manager != nil, rebootEvidence, !snapshot.safeToRelease {
            prepare { [weak self] in
                guard let self, let ready = self.ports.connection() else { return }
                self.manager?.reconnected(connectionGeneration: ready.generation, writeCapacity: ready.writeCapacity)
            }
        }
    }

    /// Bind every admitted link before ordinary version replies arrive. OTA-channel readiness is separate.
    func connectionChanged(deviceId: String, generation: Int) {
        guard deviceId == snapshot.deviceId else { return }
        state.update { $0.connectionGeneration = generation }
    }

    func inventoryChanged(_ inventory: NimoOtaManager.Inventory, connectionGeneration: Int) {
        guard snapshot.connectionGeneration == connectionGeneration else { return }
        state.update {
            $0.observedFirmware = inventory.firmwareDetail
            $0.inventory["packedVersion"] = inventory.packedVersion
            $0.inventory["compatible"] = ports.isCompatible(inventory.firmwareDetail, inventory.packedVersion) ? "true" : "false"
            $0.inventory["revision"] = String((Int($0.inventory["revision"] ?? "0") ?? 0) + 1)
        }
    }

    private func makeManager(firmware: Data, target: NimoOtaManager.Target, connection: Connection, recoveringReboot: Bool = false) -> NimoOtaManager {
        let admittedOperation = operation
        return NimoOtaManager(firmware: firmware, target: target, writeCapacity: connection.writeCapacity,
                              connectionGeneration: connection.generation, recoveringReboot: recoveringReboot, ports: .init(
                                  now: ports.now, schedule: ports.schedule, write: ports.write, readInventory: ports.readInventory,
                                  journal: { [weak self] native in
                                      guard let self, self.operation == admittedOperation, let request = self.request, let journal = self.journal else {
                                          throw FirmwareUpdaterError("invalid_journal", "The update owner or recovery record changed")
                                      }
                                      var record = self.snapshot
                                      record.phase = native.phase; record.safeToRelease = native.safeToRelease
                                      record.progress = native.progress; record.error = native.error
                                      try journal.write(.init(snapshot: record, request: request, recoveryStage: self.rebootEvidence ? "synchronized" : nil))
                                  },
                                  changed: { [weak self] native in
                                      guard let self, self.operation == admittedOperation else { return }
                                      if ["restarting", "verifying"].contains(native.phase) { self.rebootEvidence = true }
                                      if native.safeToRelease { self.release() }
                                      self.state.update {
                                          $0.phase = native.phase; $0.progress = native.progress; $0.safeToRelease = native.safeToRelease
                                          $0.error = native.error; $0.canReconcile = self.rebootEvidence && !native.safeToRelease
                                          if let firmware = native.observedFirmware { $0.observedFirmware = firmware }
                                      }
                                  }
                              ))
    }

    private func prepare(_ completion: @escaping () -> Void) {
        guard !preparing else { return }
        guard let connection = ports.connection(), connection.deviceId == snapshot.deviceId else {
            preparationFailed(FirmwareUpdaterError("disconnected", "The intended NIMO is not connected")); return
        }
        preparing = true; owned = true
        preparationGeneration += 1
        let preparation = preparationGeneration
        let expected = operation
        cancelPrepare = ports.schedule(30) { [weak self] in
            guard let self, self.operation == expected, self.preparationGeneration == preparation, self.preparing else { return }
            self.preparationFailed(FirmwareUpdaterError("timeout", "OTA channel preparation timed out"))
        }
        ports.prepare { [weak self] error in
            guard let self, self.operation == expected, self.preparationGeneration == preparation, self.preparing else { return }
            self.cancelPrepare?(); self.cancelPrepare = nil; self.preparing = false
            if let error { self.preparationFailed(error) }
            else if self.ports.connection()?.generation != connection.generation || self.ports.connection()?.deviceId != connection.deviceId {
                self.preparationFailed(FirmwareUpdaterError("stale_offer", "The NIMO connection changed during preparation"))
            } else { completion() }
        }
    }

    private func preparationFailed(_ error: Error) {
        preparationGeneration += 1
        cancelPrepare?(); cancelPrepare = nil; preparing = false
        let safe = manager == nil || manager?.snapshot.phase == "idle" || manager?.snapshot.safeToRelease == true
        if safe { release() }
        state.update { $0.phase = safe ? "failed" : "interrupted"; $0.safeToRelease = safe; $0.error = error.localizedDescription }
        if let journal, let request { try? journal.write(.init(snapshot: snapshot, request: request, recoveryStage: rebootEvidence ? "synchronized" : nil)) }
    }

    private func release() {
        if owned { owned = false; ports.release() }
    }

    private func connected() throws -> Connection {
        guard let connection = ports.connection(), connection.deviceId == snapshot.deviceId else {
            throw FirmwareUpdaterError("disconnected", "The intended NIMO is not connected")
        }
        return connection
    }

    private func target(from request: FirmwareStartRequest) throws -> NimoOtaManager.Target {
        guard let artifact = request.artifact, let hash = artifact.sha256, hash.count == 64,
              hash.allSatisfy({ $0.isHexDigit }), let size = artifact.size,
              let hardware = hex(request.metadata["hardwareId"], count: 4),
              let peer = hex(request.metadata["peerVersion"], count: 2),
              let packed = request.metadata["packedVersion"], !packed.isEmpty, !artifact.targetVersion.isEmpty
        else {
            throw FirmwareUpdaterError("invalid_artifact", "NIMO requires a SHA-256 pin and full target identity")
        }
        return .init(sha256: hash, size: size, hardwareId: hardware, firmwareDetail: artifact.targetVersion, packedVersion: packed, peerVersion: peer)
    }

    private func hex(_ value: String?, count: Int) -> Data? {
        guard let value, value.count == count * 2, value.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { return nil }
        let chars = Array(value)
        return Data(stride(from: 0, to: chars.count, by: 2).map { UInt8(String(chars[$0 ... $0 + 1]), radix: 16)! })
    }
}
