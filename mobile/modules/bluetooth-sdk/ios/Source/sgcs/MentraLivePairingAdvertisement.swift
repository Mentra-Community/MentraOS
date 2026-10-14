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

/// How to reach glasses that already left discoverable advertising. A fresh name
/// scan cannot see them after the BLE bond; the peripheral found during pairing
/// has to be connected directly.
enum MentraLiveKnownConnectRoute: String {
    case waitForPower
    case cachedPeripheral
    case savedIdentifier
    case alreadyConnected
    case scan

    static func decide(
        bluetoothPoweredOn: Bool,
        hasCachedPeripheral: Bool,
        hasSavedIdentifier: Bool,
        systemConnectedMatch: Bool
    ) -> MentraLiveKnownConnectRoute {
        if !bluetoothPoweredOn {
            return .waitForPower
        }
        if hasCachedPeripheral {
            return .cachedPeripheral
        }
        if hasSavedIdentifier {
            return .savedIdentifier
        }
        if systemConnectedMatch {
            return .alreadyConnected
        }
        return .scan
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

    /// `secure_pairing_capable` only means the firmware can do secure pairing.
    /// Ownership is the separate `owner_committed` bit, set after the BLE bond.
    static func pairingInfoConfirmsOwner(ownerCommitted: Bool) -> Bool {
        ownerCommitted
    }

    /// Matches the glasses' absolute pairing window cap; the idle timer can be held that long.
    static let pairingWindowAbsoluteMs = 300_000
    private static let pairingWindowMinMs = 5_000

    /// Stay out for the whole window, not just its idle timeout. Mirrors Android
    /// `MentraLiveOwnerLossPolicy.yieldMs`.
    static func yieldMs(windowMs: Int) -> Int {
        min(pairingWindowAbsoluteMs, max(pairingWindowMinMs, max(windowMs, pairingWindowAbsoluteMs)))
    }

    /// Ownership transfer (pairing spec T1): when the glasses kept the previous owner while they
    /// opened the window (`owner_retained`), that owner's phone yields for the window instead of
    /// standing down. Absent/false keeps the 3.3 stand-down. Mirrors Android
    /// `MentraLiveOwnerLossPolicy.shouldYieldOnEnteringPairingMode`.
    static func shouldYieldOnEnteringPairingMode(ownerRetained: Bool) -> Bool {
        ownerRetained
    }

    /// A connect rejection while this phone is yielding is the glasses refusing the retained
    /// owner on purpose (T2), not owner loss, so it never enters `MentraLiveOwnerRejectionStreak`.
    static func shouldRecordOwnerRejection(yieldActive: Bool) -> Bool {
        !yieldActive
    }

    /// While the glasses report `awaiting_confirm` the user is on the replace-owner confirm
    /// screen and no bond can follow until `confirm_replace_owner` succeeds. The secure pairing
    /// wait must not start (or must not fail the pair) in that state. A confirm result with
    /// `ok == true` re-arms it, because the bond follows. Mirrors Android
    /// `MentraLiveOwnerLossPolicy.shouldRunSecureBondWait`.
    static func shouldRunSecurePairingWait(awaitingConfirm: Bool) -> Bool {
        !awaitingConfirm
    }

    /// The `confirm_replace_owner_result` outcome that lets the pairing wait run again.
    static func shouldRearmSecurePairingWaitAfterConfirm(ok: Bool) -> Bool {
        ok
    }

    /// A connect-time authentication failure on saved secure glasses. Legacy firmware never
    /// rejects a non-owner on purpose, and during an explicit pairing attempt the user is
    /// pairing anew. This is one observation; `MentraLiveOwnerRejectionStreak` decides when it
    /// adds up to owner loss.
    static func isOwnerRejection(
        isAuthFailure: Bool,
        explicitPairing: Bool,
        secureFirmware: Bool
    ) -> Bool {
        secureFirmware && !explicitPairing && isAuthFailure
    }
}

/// Tracks owner rejections across automatic reconnects. One rejection can be a glasses reboot
/// or a stale bond, so owner loss needs `rejectionsToStandDown` attempts in a row that span at
/// least `minSpanMs`. A session that reaches ready calls `reset()`. The firmware's own
/// `entering_pairing_mode` event is explicit and does not go through this streak.
struct MentraLiveOwnerRejectionStreak {
    static let rejectionsToStandDown = 3
    /// The rejections must keep arriving for about this long, so a glasses reboot is not owner loss.
    static let minSpanMs = 45_000
    /// A gap this long between rejections means they are unrelated, not one streak.
    static let streakGapMs = 90_000
    /// One failed attempt can report twice (didFailToConnect and didDisconnect). Count it once.
    static let sameAttemptMs = 2_000

    private var count = 0
    private var firstAtMs = 0
    private var lastAtMs = 0

    /// Records one rejection and returns true once the streak means owner loss.
    mutating func record(nowMs: Int) -> Bool {
        if count > 0, nowMs - lastAtMs <= Self.sameAttemptMs {
            return reached(nowMs: nowMs)
        }
        if count > 0, nowMs - lastAtMs > Self.streakGapMs {
            count = 0
        }
        if count == 0 { firstAtMs = nowMs }
        count += 1
        lastAtMs = nowMs
        return reached(nowMs: nowMs)
    }

    mutating func reset() {
        count = 0
        firstAtMs = 0
        lastAtMs = 0
    }

    private func reached(nowMs: Int) -> Bool {
        count >= Self.rejectionsToStandDown && nowMs - firstAtMs >= Self.minSpanMs
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
