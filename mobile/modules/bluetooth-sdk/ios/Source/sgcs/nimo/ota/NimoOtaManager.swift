import CryptoKit
import Foundation

/// Native, single-attempt NIMO updater. Its SGC supplies the existing connection and serial executor.
/// Observer lifetime is unrelated to transfer lifetime. No failure path sends reset or guesses a resume offset.
final class NimoOtaManager {
    struct Target {
        let sha256: String
        let size: Int
        let hardwareId: Data
        let firmwareDetail: String
        let packedVersion: String
        let peerVersion: Data
    }

    struct Inventory {
        let firmwareDetail: String
        let packedVersion: String
    }

    struct Snapshot {
        var phase = "idle"
        var progress: Double?
        var safeToRelease = true
        var error: String?
        var observedFirmware: String?
    }

    struct Ports {
        /// All callbacks, including timers, must run on the SGC's serial executor.
        var now: () -> TimeInterval
        var schedule: (TimeInterval, @escaping () -> Void) -> (() -> Void)
        /// Completion means submitted using native write-without-response backpressure, not a device ACK.
        var write: (Data, @escaping (Error?) -> Void) -> Void
        var readInventory: (@escaping (Result<Inventory, Error>) -> Void) -> Void
        /// Must persist atomically or throw. Called before any command that enters upgrade mode.
        var journal: (Snapshot) throws -> Void
        var changed: (Snapshot) -> Void
    }

    private(set) var snapshot = Snapshot()
    private let ports: Ports
    private let target: Target
    private let firmware: Data
    private var capacity: Int
    private var generation: Int
    private let decoder = NimoOtaProtocol.Decoder()
    private var sequence: UInt8 = 0
    private var exchangeId = 0
    private var pending: (command: UInt8, sequence: UInt8, id: Int, callback: (Result<Data, Error>) -> Void)?
    private var cancelTimer: (() -> Void)?
    private var cancelDelay: (() -> Void)?
    private var entered = false
    private var rebootAttempted = false
    private var crc = false
    private var covered: [Bool]
    private var coveredCount = 0
    private var stalls = 0
    private var transferStarted: TimeInterval = 0
    private var syncPending = 0
    private var syncFailures = 0
    private var operation = 0

    init(firmware: Data, target: Target, writeCapacity: Int, connectionGeneration: Int, ports: Ports) {
        self.firmware = firmware
        self.target = target
        capacity = min(512, writeCapacity)
        generation = connectionGeneration
        self.ports = ports
        covered = Array(repeating: false, count: firmware.count)
    }

    func start() {
        guard snapshot.phase == "idle" else { return }
        transition("preparing", safe: false)
        do {
            guard firmware.count == target.size, !firmware.isEmpty,
                  SHA256.hash(data: firmware).map({ String(format: "%02x", $0) }).joined() == target.sha256.lowercased(),
                  target.hardwareId.count == 4, target.peerVersion.count == 2,
                  !target.firmwareDetail.isEmpty, !target.packedVersion.isEmpty, capacity > 20
            else { throw failure("Firmware identity or OTA write capacity is invalid") }
        } catch { fail(error); return }
        exchange(NimoOtaProtocol.info, params: Data(repeating: 255, count: 4)) { [weak self] body in
            guard let self else { return }
            try self.validateInfo(body, verifying: false)
            self.exchange(NimoOtaProtocol.fileOffsetCommand) { [weak self] body in
                guard let self else { return }
                let header = try NimoOtaProtocol.firmwareSlice(self.firmware, NimoOtaProtocol.fileOffset(body))
                self.exchange(NimoOtaProtocol.canUpdate, params: header) { [weak self] body in
                    guard let self else { return }
                    guard body == Data([0]) || body == Data([3]) else { throw self.failure("Glasses refused this firmware or prerequisites") }
                    try self.ports.journal(self.snapshot)
                    // The send outcome may be lost. Once entry is attempted, no timeout proves safe release.
                    self.entered = true
                    self.exchange(NimoOtaProtocol.enter) { [weak self] body in
                        guard let self else { return }
                        let entry = try NimoOtaProtocol.enterResult(body)
                        self.crc = entry.crc
                        self.transferStarted = self.ports.now()
                        self.transition("transferring", safe: false, progress: 0)
                        try self.sendBlock(entry.slice)
                    }
                }
            }
        }
    }

    func receive(_ data: Data, connectionGeneration: Int) {
        guard connectionGeneration == generation, snapshot.phase != "interrupted" else { return }
        do {
            for reply in try decoder.feed(data) {
                guard let expected = pending, expected.command == reply.command, expected.sequence == reply.sequence else { continue }
                pending = nil
                cancelTimer?(); cancelTimer = nil
                if reply.status == 0 { expected.callback(.success(reply.body)) }
                else { expected.callback(.failure(failure("OTA command \(reply.command) returned status \(reply.status)"))) }
            }
        } catch { fail(error) }
    }

    func disconnected(connectionGeneration: Int) {
        guard connectionGeneration == generation, !snapshot.safeToRelease else { return }
        if snapshot.phase == "restarting" {
            clearExchange()
            // Keep the existing reconnect deadline. The SGC reconnects the same physical peripheral.
        } else { fail(failure("Connection lost; transfer recovery requires device inspection")) }
    }

    /// Called only after the same device's OTA channel is ready on a new connection.
    func reconnected(connectionGeneration: Int, writeCapacity: Int) {
        guard snapshot.phase == "restarting" || (snapshot.phase == "interrupted" && rebootAttempted),
              connectionGeneration != generation else { return }
        generation = connectionGeneration
        capacity = min(512, writeCapacity)
        decoder.reset()
        cancelDelay?(); cancelDelay = nil
        verifyReadback()
    }

    private func verifyReadback() {
        snapshot.error = nil
        transition("verifying", safe: false)
        let currentOperation = operation
        let currentGeneration = generation
        cancelTimer = ports.schedule(30) { [weak self] in self?.fail(self?.failure("Firmware readback timed out")) }
        ports.readInventory { [weak self] result in
            guard let self, self.operation == currentOperation, self.generation == currentGeneration, self.snapshot.phase == "verifying" else { return }
            self.cancelTimer?(); self.cancelTimer = nil
            switch result {
            case let .failure(error): self.fail(error)
            case let .success(inventory):
                self.snapshot.observedFirmware = inventory.firmwareDetail
                guard inventory.firmwareDetail == self.target.firmwareDetail, inventory.packedVersion == self.target.packedVersion else {
                    self.fail(self.failure("Observed firmware does not match the approved target")); return
                }
                self.exchange(NimoOtaProtocol.info, params: Data(repeating: 255, count: 4)) { [weak self] body in
                    guard let self else { return }
                    try self.validateInfo(body, verifying: true)
                    self.transition("complete", safe: true)
                    try self.ports.journal(self.snapshot)
                }
            }
        }
    }

    private func validateInfo(_ body: Data, verifying: Bool) throws {
        let fields = try NimoOtaProtocol.deviceInfo(body)
        guard fields[1] == target.hardwareId, fields[3] == Data([1]), fields[5] == Data([1]),
              let batteries = fields[2], batteries.count == 2, batteries.allSatisfy({ $0 <= 100 })
        else { throw failure("Glasses identity, both batteries, or peer readiness is unavailable") }
        // Vendor CAN_UPDATE decides the battery threshold. Do not substitute Live's threshold.
        if verifying {
            guard let versions = fields[0], versions.count == 5,
                  versions.prefix(2) == target.peerVersion, versions.dropFirst(2).prefix(2) == target.peerVersion
            else { throw failure("The two glasses firmware versions have not converged") }
        }
    }

    private func sendBlock(_ slice: NimoOtaProtocol.Slice) throws {
        guard ports.now() - transferStarted <= 1200 else { throw failure("Transfer exceeded its 20-minute bound") }
        let parts = try NimoOtaProtocol.blockParts(firmware, slice: slice, crc: crc, writeCapacity: capacity)
        sendPart(parts, index: 0) { [weak self] body in
            guard let self else { return }
            let next = try NimoOtaProtocol.blockResult(body)
            let start = Int(slice.offset)
            var added = 0
            for index in start ..< start + slice.length where !self.covered[index] {
                self.covered[index] = true; added += 1
            }
            self.coveredCount += added
            self.stalls = added == 0 ? self.stalls + 1 : 0
            guard self.stalls < 5 else { throw self.failure("Five repeated blocks without progress") }
            self.transition("transferring", safe: false, progress: Double(self.coveredCount) / Double(self.firmware.count))
            if next.slice.offset == 0, next.slice.length == 0 {
                self.transition("validating", safe: false)
                self.exchange(NimoOtaProtocol.validate, timeout: 30) { [weak self] body in
                    guard let self else { return }
                    guard body == Data([0]) else { throw self.failure("Device image validation failed") }
                    self.transition("synchronizing", safe: false)
                    self.pollSync()
                }
            } else {
                _ = try NimoOtaProtocol.firmwareSlice(self.firmware, next.slice)
                self.delay(Double(next.delayMs) / 1000) { [weak self] in
                    guard let self else { return }
                    do { try self.sendBlock(next.slice) } catch { self.fail(error) }
                }
            }
        }
    }

    private func sendPart(_ parts: [Data], index: Int, completion: @escaping (Data) throws -> Void) {
        if index == parts.count - 1 {
            exchange(NimoOtaProtocol.block, params: parts[index], timeout: 30, completion: completion)
        } else {
            do {
                let packet = try nextPacket(NimoOtaProtocol.block, params: parts[index])
                let currentOperation = operation
                // Includes native write backpressure; a stalled queue cannot hold the device forever silently.
                cancelTimer = ports.schedule(30) { [weak self] in self?.fail(self?.failure("OTA write queue stalled")) }
                ports.write(packet) { [weak self] error in
                    guard let self, self.operation == currentOperation else { return }
                    self.cancelTimer?(); self.cancelTimer = nil
                    if let error { self.fail(error); return }
                    self.delay(0.005) { [weak self] in self?.sendPart(parts, index: index + 1, completion: completion) }
                }
            } catch { fail(error) }
        }
    }

    private func pollSync() {
        exchangeResult(NimoOtaProtocol.sync, timeout: 8) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(Data([0])):
                do {
                    self.transition("restarting", safe: false)
                    try self.ports.journal(self.snapshot)
                    // Reset has status/SN only. A disconnect may race its ACK; neither is final success.
                    let packet = try self.nextPacket(NimoOtaProtocol.reset, params: Data([0]))
                    self.rebootAttempted = true
                    self.ports.write(packet) { [weak self] error in
                        guard let self, self.snapshot.phase == "restarting" else { return }
                        if let error { self.fail(error) }
                    }
                    if self.snapshot.phase == "restarting" {
                        self.delay(180) { [weak self] in self?.fail(self?.failure("Reconnect and firmware verification are still required")) }
                    }
                } catch { self.fail(error) }
                return
            case .success(Data([1])): self.syncPending += 1
            default: self.syncFailures += 1
            }
            guard self.syncPending < 180, self.syncFailures < 8 else {
                self.fail(self.failure("Peer synchronization is unconfirmed; no reboot was sent")); return
            }
            self.delay(1) { [weak self] in self?.pollSync() }
        }
    }

    private func exchange(_ command: UInt8, params: Data = Data(), timeout: TimeInterval = 15, completion: @escaping (Data) throws -> Void) {
        exchangeResult(command, params: params, timeout: timeout) { [weak self] result in
            do { try completion(result.get()) } catch { self?.fail(error) }
        }
    }

    private func exchangeResult(_ command: UInt8, params: Data = Data(), timeout: TimeInterval, completion: @escaping (Result<Data, Error>) -> Void) {
        do {
            let packet = try nextPacket(command, params: params)
            let sn = sequence
            exchangeId += 1
            let id = exchangeId
            let currentOperation = operation
            pending = (command, sn, id, completion)
            cancelTimer = ports.schedule(timeout) { [weak self] in
                guard let self, self.pending?.id == id, self.operation == currentOperation else { return }
                self.pending = nil; self.cancelTimer = nil
                completion(.failure(self.failure("OTA command \(command) timed out")))
            }
            ports.write(packet) { [weak self] error in
                guard let self, let error, self.operation == currentOperation,
                      self.pending?.id == id else { return }
                self.clearExchange()
                completion(.failure(error))
            }
        } catch { completion(.failure(error)) }
    }

    private func nextPacket(_ command: UInt8, params: Data = Data()) throws -> Data {
        sequence &+= 1
        let packet = try NimoOtaProtocol.request(command, sequence: sequence, params: params)
        guard packet.count <= capacity else { throw failure("OTA request exceeds the negotiated write capacity") }
        return packet
    }

    private func delay(_ seconds: TimeInterval, _ callback: @escaping () -> Void) {
        cancelDelay?()
        let currentOperation = operation
        cancelDelay = ports.schedule(seconds) { [weak self] in
            guard let self, self.operation == currentOperation else { return }
            self.cancelDelay = nil
            callback()
        }
    }

    private func clearExchange() {
        cancelTimer?(); cancelTimer = nil
        pending = nil
        decoder.reset()
    }

    private func transition(_ phase: String, safe: Bool, progress: Double? = nil) {
        snapshot.phase = phase; snapshot.progress = progress; snapshot.safeToRelease = safe
        ports.changed(snapshot)
    }

    private func fail(_ error: Error?) {
        guard snapshot.phase != "complete" else { return }
        operation += 1
        clearExchange()
        cancelDelay?(); cancelDelay = nil
        snapshot.error = error?.localizedDescription ?? "OTA interrupted"
        transition(entered ? "interrupted" : "failed", safe: !entered)
        try? ports.journal(snapshot)
    }

    private func failure(_ message: String) -> Error {
        NimoOtaProtocol.ProtocolError(message: message)
    }
}
