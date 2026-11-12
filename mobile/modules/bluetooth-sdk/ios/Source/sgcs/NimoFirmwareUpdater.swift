import CryptoKit
import Foundation

/// The one NIMO firmware the app supports: the vendor's 537cf1 dynamic-v1 build.
enum NimoFirmwareTarget {
    static let packedVersion = "0.1.1.1"
    static let buildTag = "537cf1"
    static let sha256 = "5e23c574e3dfd8c27172f4f9a33475e6efd0d33e7230bfcce8f4fe8ca59fe433"
    static let resourceBundle = "MentraNimoFirmware"
    static let resourceName = "nimo-firmware-0.1.1.1-537cf1"
    static let updatingText = "Updating your NIMO glasses.\n\nKeep the Mentra app open."

    /// A missing detail string (older firmware) is judged on the packed version alone.
    static func isCurrent(packedVersion: String, detail: String) -> Bool {
        packedVersion == self.packedVersion && (detail.isEmpty || detail.contains("-\(buildTag)-"))
    }

    static func hash(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// The bundled image, only if it is exactly the expected file.
    static func load() -> Data? {
        let candidates = [Bundle(for: Nimo.self), Bundle.main]
        for bundle in candidates {
            let resources = bundle.url(forResource: resourceBundle, withExtension: "bundle").flatMap(Bundle.init(url:)) ?? bundle
            guard let url = resources.url(forResource: resourceName, withExtension: "bin"),
                  let data = try? Data(contentsOf: url) else { continue }
            if hash(data) == sha256 { return data }
            Bridge.log("NIMO: bundled firmware hash mismatch")
            return nil
        }
        Bridge.log("NIMO: bundled firmware unavailable")
        return nil
    }
}

/// Single-attempt NIMO OTA over the 2001/2002 channel. Main-thread confined; `schedule` posts there.
/// `finished` gets nil once the reboot command was sent, otherwise the failure reason.
/// No failure path sends reset; the next connection decides again from the reported version.
final class NimoFirmwareUpdater {
    private struct Failure: Error, LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private final class Pending {
        let command: UInt8
        let sequence: UInt8
        let callback: (Result<Data, Error>) -> Void
        init(_ command: UInt8, _ sequence: UInt8, _ callback: @escaping (Result<Data, Error>) -> Void) {
            self.command = command; self.sequence = sequence; self.callback = callback
        }
    }

    private let firmware: Data
    private let capacity: Int
    private let schedule: NimoScheduler
    private let write: (Data, @escaping (Bool) -> Void) -> Void
    private let progress: (Int) -> Void
    private let finished: (String?) -> Void
    private let decoder = NimoOtaProtocol.Decoder()
    private var sequence: UInt8 = 0
    private var pending: Pending?
    private var cancelTimer: (() -> Void)?
    private var cancelDelay: (() -> Void)?
    private var done = false
    private var crc = false
    private var covered: [Bool]
    private var coveredCount = 0
    private var lastPercent = -1
    private var stalls = 0
    private var transferStarted = Date()
    private var syncPending = 0
    private var syncFailures = 0

    init(firmware: Data, writeCapacity: Int, schedule: @escaping NimoScheduler,
         write: @escaping (Data, @escaping (Bool) -> Void) -> Void,
         progress: @escaping (Int) -> Void, finished: @escaping (String?) -> Void)
    {
        self.firmware = Data(firmware)
        capacity = min(512, writeCapacity)
        self.schedule = schedule
        self.write = write
        self.progress = progress
        self.finished = finished
        covered = Array(repeating: false, count: firmware.count)
    }

    func start() {
        exchange(NimoOtaProtocol.info, Data(repeating: 0xFF, count: 4)) { [self] info in
            try checkDeviceInfo(info)
            exchange(NimoOtaProtocol.fileOffsetCommand) { [self] body in
                let header = try NimoOtaProtocol.firmwareSlice(firmware, NimoOtaProtocol.fileOffset(body))
                exchange(NimoOtaProtocol.canUpdate, header) { [self] result in
                    // 0 = can update, 3 = same image already staged; anything else is a refusal.
                    guard result == Data([0]) || result == Data([3]) else {
                        throw Failure(message: "Glasses refused the firmware (battery or prerequisites)")
                    }
                    exchange(NimoOtaProtocol.enter) { [self] entryBody in
                        let entry = try NimoOtaProtocol.enterResult(entryBody)
                        crc = entry.crc
                        transferStarted = Date()
                        try sendBlock(entry.slice)
                    }
                }
            }
        }
    }

    func receive(_ data: Data) {
        guard !done else { return }
        do {
            for reply in try decoder.feed(data) {
                guard let expected = pending, expected.command == reply.command, expected.sequence == reply.sequence else { continue }
                pending = nil
                cancelTimer?(); cancelTimer = nil
                if reply.status == 0 { expected.callback(.success(reply.body)) } else {
                    expected.callback(.failure(Failure(message: "OTA command \(reply.command) returned status \(reply.status)")))
                }
            }
        } catch { fail(error) }
    }

    /// The connection went away; stop without reporting.
    func cancel() {
        done = true
        clearTimers()
    }

    private func checkDeviceInfo(_ body: Data) throws {
        let fields = try NimoOtaProtocol.deviceInfo(body)
        guard fields[3] == Data([1]), fields[5] == Data([1]), fields[2]?.count == 2 else {
            throw Failure(message: "Both arms must be connected and ready to update")
        }
    }

    private func sendBlock(_ slice: NimoOtaProtocol.Slice) throws {
        guard Date().timeIntervalSince(transferStarted) <= 20 * 60 else { throw Failure(message: "Transfer exceeded 20 minutes") }
        let parts = try NimoOtaProtocol.blockParts(firmware, slice: slice, crc: crc, writeCapacity: capacity)
        sendPart(parts, 0) { [self] body in
            let next = try NimoOtaProtocol.blockResult(body)
            var added = 0
            for index in Int(slice.offset) ..< Int(slice.offset) + slice.length where !covered[index] {
                covered[index] = true
                added += 1
            }
            coveredCount += added
            stalls = added == 0 ? stalls + 1 : 0
            guard stalls < 5 else { throw Failure(message: "Five repeated blocks without progress") }
            let percent = coveredCount * 100 / firmware.count
            if percent != lastPercent { lastPercent = percent; progress(percent) }
            if next.slice.offset == 0, next.slice.length == 0 {
                exchange(NimoOtaProtocol.validate, timeout: 30) { [self] validation in
                    guard validation == Data([0]) else { throw Failure(message: "Glasses rejected the transferred image") }
                    pollSync()
                }
            } else {
                _ = try NimoOtaProtocol.firmwareSlice(firmware, next.slice)
                delay(TimeInterval(next.delayMs) / 1000) { [self] in try sendBlock(next.slice) }
            }
        }
    }

    private func sendPart(_ parts: [Data], _ index: Int, completion: @escaping (Data) throws -> Void) {
        if index == parts.count - 1 { exchange(NimoOtaProtocol.block, parts[index], timeout: 30, completion); return }
        do {
            let packet = try nextPacket(NimoOtaProtocol.block, parts[index])
            write(packet) { [weak self] ok in
                guard let self, !self.done else { return }
                if !ok { self.fail(Failure(message: "OTA write failed")); return }
                self.delay(0.005) { [self] in self.sendPart(parts, index + 1, completion: completion) }
            }
        } catch { fail(error) }
    }

    /// Wait for the right arm to copy the image to the left arm, then reboot both.
    private func pollSync() {
        exchangeResult(NimoOtaProtocol.sync, timeout: 8) { [self] result in
            let body = try? result.get()
            if body == Data([0]) {
                do {
                    let packet = try nextPacket(NimoOtaProtocol.reset, Data([0]))
                    write(packet) { _ in }
                    done = true
                    clearTimers()
                    finished(nil)
                } catch { fail(error) }
                return
            }
            if body == Data([1]) { syncPending += 1 } else { syncFailures += 1 }
            if syncPending >= 180 || syncFailures >= 8 {
                fail(Failure(message: "Arms did not finish synchronizing; no reboot sent"))
            } else {
                delay(1) { [self] in pollSync() }
            }
        }
    }

    private func exchange(_ command: UInt8, _ params: Data = Data(), timeout: TimeInterval = 15,
                          _ completion: @escaping (Data) throws -> Void)
    {
        exchangeResult(command, params, timeout: timeout) { [weak self] result in
            do { try completion(result.get()) } catch { self?.fail(error) }
        }
    }

    private func exchangeResult(_ command: UInt8, _ params: Data = Data(), timeout: TimeInterval,
                                _ completion: @escaping (Result<Data, Error>) -> Void)
    {
        guard !done else { return }
        do {
            let packet = try nextPacket(command, params)
            let entry = Pending(command, sequence, completion)
            pending = entry
            cancelTimer = schedule(timeout) { [weak self] in
                guard let self, self.pending === entry, !self.done else { return }
                self.pending = nil; self.cancelTimer = nil
                completion(.failure(Failure(message: "OTA command \(command) timed out")))
            }
            write(packet) { [weak self] ok in
                guard let self, !ok, self.pending === entry, !self.done else { return }
                self.pending = nil
                self.cancelTimer?(); self.cancelTimer = nil
                completion(.failure(Failure(message: "OTA write failed")))
            }
        } catch { completion(.failure(error)) }
    }

    private func nextPacket(_ command: UInt8, _ params: Data = Data()) throws -> Data {
        sequence &+= 1
        let packet = try NimoOtaProtocol.request(command, sequence: sequence, params: params)
        guard packet.count <= capacity else { throw Failure(message: "OTA request exceeds the negotiated write capacity") }
        return packet
    }

    private func delay(_ seconds: TimeInterval, _ callback: @escaping () throws -> Void) {
        cancelDelay?()
        cancelDelay = schedule(seconds) { [weak self] in
            guard let self else { return }
            self.cancelDelay = nil
            guard !self.done else { return }
            do { try callback() } catch { self.fail(error) }
        }
    }

    private func clearTimers() {
        cancelTimer?(); cancelTimer = nil
        cancelDelay?(); cancelDelay = nil
        pending = nil
        decoder.reset()
    }

    private func fail(_ error: Error) {
        guard !done else { return }
        done = true
        clearTimers()
        finished(error.localizedDescription)
    }
}
