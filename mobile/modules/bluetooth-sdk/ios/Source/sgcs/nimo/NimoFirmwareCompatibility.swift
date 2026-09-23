import CryptoKit
import Foundation

/// Device-local operational policy. Engine supplies identities only after verifying its selected manifest.
/// It grants no permission to flash; OTA admission independently verifies the approved image and hardware.
final class NimoFirmwareCompatibility {
    struct Identity: Codable, Equatable {
        let fullVersion: String
        let packedVersion: String
    }

    private struct CachedPolicy: Codable {
        let schemaVersion: Int
        let manifestSha256: String
        let compatible: [Identity]
    }

    private let defaults: UserDefaults
    private let key: String
    private var cached: [Identity] = []
    private static let bundled: [Identity] = {
        guard let data = GeneratedDeviceFirmware.json.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let nimo = root["nimo"] as? [String: Any], let compatible = nimo["compatible"],
              let bytes = try? JSONSerialization.data(withJSONObject: compatible)
        else { return [] }
        return (try? decodeIdentities(bytes)) ?? []
    }()

    init(deviceId: String, defaults: UserDefaults = .standard) {
        self.defaults = defaults
        key = "nimo.compatibility." + SHA256.hash(data: Data(deviceId.utf8)).map { String(format: "%02x", $0) }.joined()
        if let bytes = defaults.data(forKey: key), bytes.count <= 65536,
           let policy = try? JSONDecoder().decode(CachedPolicy.self, from: bytes), policy.schemaVersion == 1,
           Self.validHash(policy.manifestSha256), policy.compatible.count <= 64, policy.compatible.allSatisfy(Self.validIdentity)
        { cached = policy.compatible }
    }

    func allows(fullVersion: String, packedVersion: String) -> Bool {
        let observed = Identity(fullVersion: fullVersion, packedVersion: packedVersion)
        return Self.bundled.contains(observed) || cached.contains(observed)
    }

    func configure(_ metadata: [String: String]) throws {
        guard let json = metadata["compatibleFirmware"], let bytes = json.data(using: .utf8),
              let hash = metadata["manifestSha256"], Self.validHash(hash)
        else { throw FirmwareUpdaterError("invalid_policy", "NIMO requires verified compatibility metadata") }
        let identities = try Self.decodeIdentities(bytes)
        let encoded = try JSONEncoder().encode(CachedPolicy(schemaVersion: 1, manifestSha256: hash, compatible: identities))
        defaults.set(encoded, forKey: key)
        cached = identities
    }

    static func permitsBeforeCompatibility(command: Int, key: Int) -> Bool {
        command == NimoProtocol.CMD_GET_PARAMETER ||
            (command == NimoProtocol.CMD_SET_PARAMETER && [NimoProtocol.SET_TIME, NimoProtocol.SET_PHONE_TYPE].contains(key))
    }

    private static func decodeIdentities(_ data: Data) throws -> [Identity] {
        guard data.count <= 65536 else { throw FirmwareUpdaterError("invalid_policy", "NIMO compatibility policy is too large") }
        let identities = try JSONDecoder().decode([Identity].self, from: data)
        guard identities.count <= 64, identities.allSatisfy(validIdentity) else {
            throw FirmwareUpdaterError("invalid_policy", "NIMO firmware identities are invalid")
        }
        return identities
    }

    private static func validHash(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { $0.isASCII && $0.isHexDigit && !$0.isUppercase }
    }

    private static func validIdentity(_ value: Identity) -> Bool {
        let parts = value.packedVersion.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let bounds = [15, 127, 511, 4095]
        for (index, part) in parts.enumerated() {
            guard let number = Int(part), number >= 0, number <= bounds[index], String(number) == part else { return false }
        }
        let prefix = "FW-VERSION-v\(value.packedVersion)-"
        guard value.fullVersion.count <= 512, value.fullVersion.hasPrefix(prefix) else { return false }
        let suffix = String(value.fullVersion.dropFirst(prefix.count))
        return suffix.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]*$", options: .regularExpression) != nil
    }
}
