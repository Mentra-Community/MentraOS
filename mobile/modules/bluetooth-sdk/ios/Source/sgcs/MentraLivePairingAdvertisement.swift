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

    /// How long a pending reconnect reports CONNECTING before settling to DISCONNECTED. Matches
    /// the span of the scan backoff it replaces (1+2+4+8+16 s, then 30 s × 5 attempts).
    static let pendingReconnectSettleMs = 181_000

    /// Whether an unexpected link loss should re-arm a pending connection to the same
    /// peripheral. iOS completes a pending `connect` whenever the glasses advertise again,
    /// even while the app is suspended (phone locked), and wakes the app to handle it. A scan
    /// without service filters returns nothing in the background, and the backoff timers that
    /// drive it stop while the app is suspended, so the scan path alone never reconnects there.
    static func shouldReconnectDirectly(
        isKilled: Bool,
        pairingYieldActive: Bool,
        bluetoothPoweredOn: Bool,
        peripheralName: String?,
        savedDeviceName: String?
    ) -> Bool {
        guard !isKilled, !pairingYieldActive, bluetoothPoweredOn,
              let peripheralName, !peripheralName.isEmpty,
              let savedDeviceName
        else {
            return false
        }
        return peripheralName == savedDeviceName
    }
}

/// Ownership of the one armed pending reconnect. Each arm returns a new attempt number, so a
/// timer captured for an earlier attempt can tell it no longer owns the connection state after
/// a failure, a fallback connect or a re-arm.
struct MentraLivePendingReconnect {
    private(set) var attempt = 0
    private(set) var isArmed = false

    mutating func arm() -> Int {
        attempt += 1
        isArmed = true
        return attempt
    }

    mutating func clear() {
        isArmed = false
    }

    func owns(_ candidate: Int) -> Bool {
        isArmed && candidate == attempt
    }
}
