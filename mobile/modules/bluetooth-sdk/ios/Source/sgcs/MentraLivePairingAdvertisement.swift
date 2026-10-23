import Foundation

struct MentraLivePairingAdvertisement: Equatable {
    let pairingMode: Bool
    let pairingCode: String
    /// The glasses' `window_id`: moves on each pairing-mode entry. Nil on firmware that does not
    /// send it. A stable extra byte (the legacy MAC that follows the trailer) is not a new entry.
    let pairingGeneration: Int?
    /// Trailer flag `OWNER_CHANGED`: the window `pairingGeneration` committed a different phone.
    /// Unauthenticated, so it only triggers one verification reconnect.
    let ownerChanged: Bool

    init(pairingMode: Bool, pairingCode: String, pairingGeneration: Int? = nil, ownerChanged: Bool = false) {
        self.pairingMode = pairingMode
        self.pairingCode = pairingCode
        self.pairingGeneration = pairingGeneration
        self.ownerChanged = ownerChanged
    }

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
    private static let ownerChangedFlag = 0x04
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
        let generationIndex = payloadBase + magicSecondOffset + 1
        let pairingGeneration = data.count > generationIndex ? Int(data[generationIndex]) : nil
        return MentraLivePairingAdvertisement(
            pairingMode: data[payloadBase + pairingFlagOffset] == pairingDiscoverable,
            pairingCode: String(format: "%02X%02X", codeHigh, codeLow),
            pairingGeneration: pairingGeneration,
            ownerChanged: capability & ownerChangedFlag != 0
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

    /// `entering_pairing_mode.window_ms` when the glasses omit it.
    static let defaultPairingWindowMs = 120_000

    /// Covers the glasses' bounded close deferral (30 s) after the window timer.
    static let pairingResumeMarginMs = 30_000

    /// How long automatic reconnect pauses for a window: the window plus the close-deferral
    /// margin. No floor beyond a missing value and no upper clamp; the glasses own the window.
    /// Mirrors Android `MentraLiveOwnerLossPolicy.yieldMs`.
    static func yieldMs(windowMs: Int) -> Int {
        (windowMs > 0 ? windowMs : defaultPairingWindowMs) + pairingResumeMarginMs
    }

    /// Automatic reconnect must not take the single BLE slot while the saved glasses advertise
    /// pairing mode. An explicit pairing attempt (the new phone, or Pair Again) still connects.
    /// Mirrors Android `MentraLiveOwnerLossPolicy.shouldStandDownInsteadOfReconnect`.
    static func shouldStandDownInsteadOfReconnect(
        pairingMode: Bool,
        savedGlasses: Bool,
        explicitPairing: Bool
    ) -> Bool {
        pairingMode && savedGlasses && !explicitPairing
    }

    /// Remaining pause after a process restart. A missing, expired, or implausible deadline (more
    /// than the pause that was persisted with it) returns 0 so the phone reconnects. Mirrors
    /// Android `MentraLiveOwnerLossPolicy.persistedYieldRemainingMs`.
    static func persistedYieldRemainingMs(untilWallMs: Int, nowWallMs: Int, pauseMs: Int) -> Int {
        guard untilWallMs > 0, pauseMs > 0 else { return 0 }
        let remaining = untilWallMs - nowWallMs
        guard remaining > 0, remaining <= pauseMs else { return 0 }
        return remaining
    }

    /// Readiness parked for the owner commit always has a deadline: an explicit secure attempt
    /// arms the pairing wait, so a missing bond or owner commit fails the pair instead of leaving
    /// it loading. Mirrors Android `MentraLiveOwnerLossPolicy.shouldRunSecureBondWait`.
    static func shouldRunSecurePairingWait(explicitPairing: Bool, securePairingTarget: Bool) -> Bool {
        explicitPairing && securePairingTarget
    }

    /// How long readiness waits after `glasses_ready` for a `pairing_info` when the selected
    /// glasses' capability is unknown. No `pairing_info` by then means legacy firmware.
    static let unknownCapabilityPairingInfoWaitMs = 5_000

    /// A ready session that gets no `pairing_info` within this time runs legacy firmware.
    static let secureFirmwareRefreshMs = 15_000

    /// The selected scan row decides (`pending_device_secure_pairing_capable`). When the row's
    /// capability is unknown, a secure `pairing_info` on this session decides. Never a name seen
    /// earlier: a unit rolled back to legacy firmware keeps its name.
    static func isSecurePairingTarget(selectedCapability: Bool?, securePairingInfoThisSession: Bool) -> Bool {
        selectedCapability ?? securePairingInfoThisSession
    }

    enum Readiness: Equatable {
        /// Report ready now.
        case ready
        /// Secure pairing: wait for `pairing_info.owner_committed`, with the pairing wait.
        case awaitOwnerCommit
        /// Unknown capability: wait `unknownCapabilityPairingInfoWaitMs` for a `pairing_info`.
        case awaitPairingInfo
    }

    /// What `glasses_ready` means for readiness. Every wait has a deadline.
    static func readinessAtGlassesReady(
        explicitPairing: Bool,
        selectedCapability: Bool?,
        securePairingInfoThisSession: Bool,
        securePairingConfirmed: Bool
    ) -> Readiness {
        guard explicitPairing, !securePairingConfirmed else { return .ready }
        if isSecurePairingTarget(
            selectedCapability: selectedCapability,
            securePairingInfoThisSession: securePairingInfoThisSession
        ) {
            return .awaitOwnerCommit
        }
        return selectedCapability == nil ? .awaitPairingInfo : .ready
    }

    /// `pair_select` tells the glasses this link is the user's explicit choice (pairing spec V4).
    /// Once per BLE session, only on an explicit attempt to secure glasses, never on an
    /// automatic reconnect. Mirrors Android `MentraLiveOwnerLossPolicy.shouldSendPairSelect`.
    static func shouldSendPairSelect(explicitPairing: Bool, securePairingTarget: Bool) -> Bool {
        explicitPairing && securePairingTarget
    }

    /// `pair_failure.code` when an explicit iOS attempt hits a Bluetooth key the glasses deleted.
    static let iosForgetPairingCode = "ios_forget_pairing"

    /// iOS CoreBluetooth error 14: the glasses deleted their BLE bond and this phone still
    /// has the old keys. GATT never opens, so the glasses cannot ask for a wipe. Stop
    /// reconnecting and tell the user to forget the glasses in Bluetooth settings.
    /// `promptedAt` is 0 when this phone has not shown that prompt yet.
    static let staleIosBondPromptCooldownSeconds: TimeInterval = 30

    static func shouldPromptToForgetStaleIosBond(
        peerRemovedPairingInformation: Bool,
        promptedAt: TimeInterval,
        now: TimeInterval
    ) -> Bool {
        guard peerRemovedPairingInformation else { return false }
        if promptedAt <= 0 { return true }
        return now - promptedAt >= staleIosBondPromptCooldownSeconds
    }

    /// A connect-time authentication failure on saved secure glasses. Legacy firmware never
    /// rejects a non-owner on purpose, and during an explicit pairing attempt the user is
    /// pairing anew. This is one observation; `MentraLivePairingStateMachine.onAuthRejection`
    /// decides what it adds up to.
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
/// least `minSpanMs`. A session that reaches ready calls `reset()`.
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

enum MentraLiveDiscoveryPolicy {
    /// How long a secure-pairing trailer from one peripheral marks its trailer-less packets as
    /// partial. Short, so glasses rolled back to legacy firmware list as legacy again.
    static let secureTrailerMemoryMs = 10_000

    /// CoreBluetooth can deliver an advertisement without the manufacturer data that holds the
    /// secure-pairing trailer (for example right after a scan starts or a link drops). A packet
    /// without it is partial only when the same peripheral showed the trailer within
    /// `secureTrailerMemoryMs`; otherwise it is legacy firmware and listed as pairable.
    static func isPartialAdvertisement(secureCapable: Bool, lastSecureTrailerAtMs: Int?, nowMs: Int) -> Bool {
        guard !secureCapable, let lastSecureTrailerAtMs else { return false }
        let elapsedMs = nowMs - lastSecureTrailerAtMs
        return elapsedMs >= 0 && elapsedMs <= secureTrailerMemoryMs
    }
}

/// Last time each peripheral advertised the secure-pairing trailer. In memory only, keyed by the
/// CoreBluetooth identifier so a same-named unit is never affected.
struct MentraLiveSecureTrailerMemory {
    private var seenAtMs: [UUID: Int] = [:]

    mutating func recordSecureTrailer(_ identifier: UUID, nowMs: Int) {
        seenAtMs = seenAtMs.filter { nowMs - $0.value <= MentraLiveDiscoveryPolicy.secureTrailerMemoryMs }
        seenAtMs[identifier] = nowMs
    }

    func hasRecentSecureTrailer(_ identifier: UUID, nowMs: Int) -> Bool {
        isPartialAdvertisement(identifier, secureCapable: false, nowMs: nowMs)
    }

    func isPartialAdvertisement(_ identifier: UUID, secureCapable: Bool, nowMs: Int) -> Bool {
        MentraLiveDiscoveryPolicy.isPartialAdvertisement(
            secureCapable: secureCapable,
            lastSecureTrailerAtMs: seenAtMs[identifier],
            nowMs: nowMs
        )
    }

    mutating func clear() {
        seenAtMs.removeAll()
    }
}
