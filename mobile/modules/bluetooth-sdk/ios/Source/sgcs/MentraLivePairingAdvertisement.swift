import Foundation

struct MentraLivePairingAdvertisement: Equatable {
    let pairingMode: Bool
    let pairingCode: String

    private static let manufacturerId: UInt16 = 0xB822
    private static let companyIdLength = 2
    private static let pairingFlagOffset = 5
    private static let pairingDiscoverable: UInt8 = 0x01
    private static let protocolVersionOffset = pairingFlagOffset + 1
    private static let capabilityOffset = protocolVersionOffset + 1
    private static let codeLowOffset = capabilityOffset + 1
    private static let codeHighOffset = codeLowOffset + 1
    private static let magicFirstOffset = codeHighOffset + 1
    private static let magicSecondOffset = magicFirstOffset + 1
    private static let protocolVersionRange = 2 ... 15
    private static let securePairingCapability = 0x01
    private static let magicFirst: UInt8 = 0x4D // M
    private static let magicSecond: UInt8 = 0x50 // P

    /// Parses CoreBluetooth manufacturer data, including its two-byte company-id prefix.
    ///
    /// Legacy firmware stores an XOR'd Classic MAC where the original pairing implementation
    /// expected version and capability bytes. Requiring the `MP` marker makes the formats
    /// unambiguous instead of probabilistically classifying MAC bytes as a secure trailer.
    static func parse(coreBluetoothManufacturerData data: Data?) -> MentraLivePairingAdvertisement? {
        guard let data, data.count > companyIdLength + magicSecondOffset else {
            return nil
        }

        let companyId = UInt16(data[0]) | (UInt16(data[1]) << 8)
        guard companyId == manufacturerId else {
            return nil
        }

        let payloadBase = companyIdLength
        let version = Int(data[payloadBase + protocolVersionOffset])
        let capability = Int(data[payloadBase + capabilityOffset])
        guard protocolVersionRange.contains(version),
              capability & securePairingCapability != 0,
              data[payloadBase + magicFirstOffset] == magicFirst,
              data[payloadBase + magicSecondOffset] == magicSecond
        else {
            return nil
        }

        let codeLow = Int(data[payloadBase + codeLowOffset])
        let codeHigh = Int(data[payloadBase + codeHighOffset])
        return MentraLivePairingAdvertisement(
            pairingMode: data[payloadBase + pairingFlagOffset] == pairingDiscoverable,
            pairingCode: String(format: "%02X%02X", codeHigh, codeLow)
        )
    }
}

enum MentraLiveConnectionAttemptPolicy {
    static func shouldAcceptDidConnect(
        pairingYieldActive: Bool,
        matchesActiveAttempt: Bool
    ) -> Bool {
        !pairingYieldActive && matchesActiveAttempt
    }
}
