import CryptoKit
import Foundation

/// Evidence for inspection after process death, never a stored authorization to start/resume.
struct FirmwareRecoveryRecord: Codable {
    var formatVersion = 1
    let snapshot: FirmwareUpdateSnapshot
    let request: FirmwareStartRequest
    var recoveryStage: String? = nil
}

final class FirmwareJournal {
    private let path: URL
    private let deviceId: String

    init(deviceId: String, directory: URL? = nil) throws {
        self.deviceId = deviceId
        let base = try directory ?? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                            appropriateFor: nil, create: true).appendingPathComponent("firmware-updates", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        #if os(iOS)
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: base.path)
        #endif
        let filename = SHA256.hash(data: Data(deviceId.utf8)).map { String(format: "%02x", $0) }.joined() + ".json"
        path = base.appendingPathComponent(filename)
    }

    func read() throws -> FirmwareRecoveryRecord? {
        guard FileManager.default.fileExists(atPath: path.path) else { return nil }
        let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
        guard let size = attributes[.size] as? NSNumber, size.intValue <= 65536 else {
            throw FirmwareUpdaterError("invalid_journal", "Firmware recovery record exceeds its size limit")
        }
        let record = try JSONDecoder().decode(FirmwareRecoveryRecord.self, from: Data(contentsOf: path))
        guard record.formatVersion == 1, record.snapshot.schemaVersion == 1,
              record.snapshot.deviceId == deviceId, record.request.deviceId == deviceId
        else {
            throw FirmwareUpdaterError("invalid_journal", "Firmware recovery record has an unsupported identity or format")
        }
        return record
    }

    func write(_ record: FirmwareRecoveryRecord) throws {
        guard record.snapshot.deviceId == deviceId, record.request.deviceId == deviceId,
              record.request.kind != "manifest"
        else {
            // Live's manifest may contain credentials. Its recovery record must use its own redacted representation.
            throw FirmwareUpdaterError("invalid_journal", "Recovery record does not match this file-based updater")
        }
        let data = try JSONEncoder().encode(record)
        guard data.count <= 65536 else { throw FirmwareUpdaterError("invalid_journal", "Recovery record exceeds its size limit") }
        try data.write(to: path, options: .atomic)
    }

    func remove() throws {
        if FileManager.default.fileExists(atPath: path.path) { try FileManager.default.removeItem(at: path) }
    }
}
