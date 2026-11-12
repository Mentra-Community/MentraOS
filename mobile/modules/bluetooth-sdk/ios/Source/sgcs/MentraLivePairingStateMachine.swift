import Foundation

/// Public Mentra Live pairing state (`MentraLivePairingState` in BluetoothSdk.types.ts).
/// Mirrors Android `MentraLivePairingState`.
enum MentraLivePairingState: Equatable {
    case normal
    /// The glasses opened a pairing window. Automatic reconnect waits until `endsAtMs` (wall clock).
    case pairingMode(windowId: Int, endsAtMs: Int)
    /// The glasses no longer accept this phone. Only an explicit pair or a forget clears it.
    case rejected

    func toMap() -> [String: Any] {
        switch self {
        case .normal:
            return ["state": "normal"]
        case let .pairingMode(windowId, endsAtMs):
            return ["state": "pairing_mode", "windowId": windowId, "endsAtMs": endsAtMs]
        case .rejected:
            return ["state": "pairing_rejected"]
        }
    }
}

/// What the connection manager must do after a `MentraLivePairingStateMachine` input.
enum MentraLivePairingEffect: Equatable {
    case none
    /// Leave the link and make no automatic connection until resumed.
    case pause
    /// The window is over: reconnect to the saved glasses.
    case resume
    /// Stop reconnecting. The glasses belong to another phone.
    case reject
}

struct MentraLivePairingTransition: Equatable {
    let effect: MentraLivePairingEffect
    let stateChanged: Bool
    let note: String
}

/// Pairing-mode pause/resume, takeover detection and rejection detection for one saved Mentra
/// Live (pairing spec "Ownership transfer v4"). Pure and clock-free: every input carries `nowMs`
/// (wall clock, because the pause deadline survives a process restart). Mirrors Android
/// `MentraLivePairingStateMachine` input for input.
struct MentraLivePairingStateMachine {
    /// Glasses flag-clear advertisements seen this soon after the notice can predate the window.
    static let flagClearGraceMs = 3_000
    /// A pairing-mode advertisement this recent still means the glasses are in pairing mode.
    static let pairingAdvertFreshMs = 10_000
    /// Window id used when protocol-3 firmware sends `owner_retained` without `window_id`.
    static let unknownWindowId = -1

    static let keyDeviceId = "pairing_v4_device_id"
    static let keyState = "pairing_v4_state"
    static let keyWindowId = "pairing_v4_window_id"
    static let keyEndsAtMs = "pairing_v4_ends_at_ms"
    static let keyPauseMs = "pairing_v4_pause_ms"
    static let keyEndedWindowId = "pairing_v4_ended_window_id"
    static let keyVerifiedWindowId = "pairing_v4_verified_window_id"
    static let keys = [
        keyDeviceId, keyState, keyWindowId, keyEndsAtMs, keyPauseMs, keyEndedWindowId, keyVerifiedWindowId,
    ]

    /// Pre-v4 stand-down phase. Its presence migrates to `.rejected`.
    static let legacyRejectionPhaseKey = "mentra_live_previous_owner_rejection_phase"
    static let legacyKeys = [
        legacyRejectionPhaseKey,
        "mentra_live_previous_owner_rejection_generation",
        "mentra_live_pairing_yield_until_wall_ms",
    ]

    private static let statePairingMode = "pairing_mode"
    private static let stateRejected = "pairing_rejected"

    private(set) var state: MentraLivePairingState = .normal
    /// Saved glasses this record belongs to. Empty until known.
    private(set) var deviceId = ""
    /// The next connection attempt is the one verification after an `OWNER_CHANGED` advertisement.
    private(set) var verificationArmed = false
    /// The window this phone paused for and that has ended. Read against `OWNER_CHANGED`.
    private(set) var endedWindowId: Int?

    private var pauseMs = 0
    private var pausedAtMs: Int?
    private var verifiedWindowId: Int?
    private var lastPairingAdvertAtMs: Int?
    private var takeoverAdvertRead = false
    private var streak = MentraLiveOwnerRejectionStreak()

    var allowsAutomaticReconnect: Bool { state == .normal }

    var isPaused: Bool {
        if case .pairingMode = state { return true }
        return false
    }

    /// A window this phone paused for has ended and no post-window advertisement has been read,
    /// so a reconnect should scan first instead of dialing the saved peripheral directly.
    var awaitingTakeoverCheck: Bool {
        state == .normal && endedWindowId != nil && !takeoverAdvertRead
    }

    func remainingPauseMs(nowMs: Int) -> Int {
        guard case let .pairingMode(_, endsAtMs) = state else { return 0 }
        return max(0, endsAtMs - nowMs)
    }

    /// Rebuild from persisted values. Unknown keys and malformed values are ignored. A record for
    /// other glasses, or a pause whose deadline passed or is implausible, does not survive.
    @discardableResult
    mutating func restore(values: [String: Any], savedDeviceId: String, nowMs: Int) -> MentraLivePairingTransition {
        resetInMemory()
        state = .normal
        deviceId = values[Self.keyDeviceId] as? String ?? ""
        endedWindowId = Self.intValue(values[Self.keyEndedWindowId])
        verifiedWindowId = Self.intValue(values[Self.keyVerifiedWindowId])
        if !savedDeviceId.isEmpty, !deviceId.isEmpty, deviceId != savedDeviceId {
            clearRecord()
            deviceId = savedDeviceId
            return none("record belongs to other glasses")
        }
        switch values[Self.keyState] as? String {
        case Self.stateRejected:
            state = .rejected
            return MentraLivePairingTransition(effect: .reject, stateChanged: true, note: "restored rejected")
        case Self.statePairingMode:
            let windowId = Self.intValue(values[Self.keyWindowId])
            let endsAtMs = Self.intValue(values[Self.keyEndsAtMs]) ?? 0
            let pause = Self.intValue(values[Self.keyPauseMs])
                ?? MentraLiveConnectionAttemptPolicy.yieldMs(
                    windowMs: MentraLiveConnectionAttemptPolicy.defaultPairingWindowMs
                )
            let remaining = MentraLiveConnectionAttemptPolicy.persistedYieldRemainingMs(
                untilWallMs: endsAtMs, nowWallMs: nowMs, pauseMs: pause
            )
            if let windowId, remaining > 0 {
                state = .pairingMode(windowId: windowId, endsAtMs: endsAtMs)
                pauseMs = pause
                return MentraLivePairingTransition(
                    effect: .pause,
                    stateChanged: true,
                    note: "restored pairing_mode window=\(windowId) remaining=\(remaining)ms"
                )
            }
            if let windowId { endedWindowId = windowId }
            return none("persisted pause ended while the app was away")
        default:
            break
        }
        if values[Self.legacyRejectionPhaseKey] is String {
            state = .rejected
            return MentraLivePairingTransition(effect: .reject, stateChanged: true, note: "migrated legacy stand-down")
        }
        return none("restored normal")
    }

    /// The current record, keyed by `keys`.
    func persisted() -> [String: Any] {
        var values: [String: Any] = [:]
        if !deviceId.isEmpty { values[Self.keyDeviceId] = deviceId }
        switch state {
        case let .pairingMode(windowId, endsAtMs):
            values[Self.keyState] = Self.statePairingMode
            values[Self.keyWindowId] = windowId
            values[Self.keyEndsAtMs] = endsAtMs
            values[Self.keyPauseMs] = pauseMs
        case .rejected:
            values[Self.keyState] = Self.stateRejected
        case .normal:
            break
        }
        if let endedWindowId { values[Self.keyEndedWindowId] = endedWindowId }
        // Armed verification is not persisted, so a window counts as verified only once its
        // verification has been used. After a restart the next OWNER_CHANGED advert re-arms it.
        if !verificationArmed, let verifiedWindowId { values[Self.keyVerifiedWindowId] = verifiedWindowId }
        return values
    }

    /// An automatic connect to `id`. A record for other glasses no longer applies.
    @discardableResult
    mutating func bindDevice(_ id: String) -> MentraLivePairingTransition {
        if id.isEmpty || id == deviceId { return none("same glasses") }
        let hadRecord = !deviceId.isEmpty
        let wasNormal = state == .normal
        if hadRecord { clearRecord() }
        deviceId = id
        return MentraLivePairingTransition(
            effect: .none,
            stateChanged: hadRecord && !wasNormal,
            note: hadRecord ? "record moved to other glasses" : "bound"
        )
    }

    /// `entering_pairing_mode`. Protocol 4 (`window_id`) pauses this phone for the window plus a
    /// margin. Firmware without ownership transfer forgets this phone on entry (pairing spec R4),
    /// so a notice without `window_id` or `owner_retained` means the glasses dropped it.
    @discardableResult
    mutating func onEnteringPairingMode(
        windowMs: Int?,
        windowId: Int?,
        ownerRetained: Bool,
        explicitAttempt: Bool,
        deviceId: String,
        nowMs: Int
    ) -> MentraLivePairingTransition {
        if !deviceId.isEmpty { self.deviceId = deviceId }
        if explicitAttempt { return none("notice during an explicit attempt") }
        if windowId == nil, !ownerRetained { return reject("forget_on_entry") }
        let id = windowId ?? Self.unknownWindowId
        if case let .pairingMode(current, _) = state, current == id {
            return none("duplicate notice for window \(id)")
        }
        let pause = MentraLiveConnectionAttemptPolicy.yieldMs(windowMs: windowMs ?? 0)
        state = .pairingMode(windowId: id, endsAtMs: nowMs + pause)
        pauseMs = pause
        pausedAtMs = nowMs
        endedWindowId = nil
        verificationArmed = false
        streak.reset()
        return MentraLivePairingTransition(effect: .pause, stateChanged: true, note: "pairing_mode window=\(id) pause=\(pause)ms")
    }

    /// `pairing_mode_ended`. Only a connected phone receives it, so the glasses still admit this
    /// phone and there is no takeover to check.
    @discardableResult
    mutating func onPairingModeEnded(reason: String?, windowId: Int?) -> MentraLivePairingTransition {
        guard case let .pairingMode(current, _) = state else { return none("not paused") }
        if let windowId, current != Self.unknownWindowId, windowId != current {
            return none("ended window \(windowId) is not \(current)")
        }
        state = .normal
        pausedAtMs = nil
        endedWindowId = nil
        return MentraLivePairingTransition(effect: .resume, stateChanged: true, note: "pairing_mode_ended reason=\(reason ?? "")")
    }

    /// An advertisement from the saved glasses carrying the secure trailer. A cleared pairing flag
    /// ends the pause early. After the window this phone paused for, `OWNER_CHANGED` for that
    /// window arms exactly one verification attempt.
    @discardableResult
    mutating func onAdvertisement(
        pairingMode: Bool,
        ownerChanged: Bool,
        generation: Int?,
        nowMs: Int
    ) -> MentraLivePairingTransition {
        lastPairingAdvertAtMs = pairingMode ? nowMs : nil
        var effect = MentraLivePairingEffect.none
        var changed = false
        var notes: [String] = []
        if case let .pairingMode(current, _) = state, !pairingMode {
            let sincePause = pausedAtMs.map { nowMs - $0 } ?? Int.max
            if sincePause >= Self.flagClearGraceMs {
                state = .normal
                pausedAtMs = nil
                endedWindowId = current
                effect = .resume
                changed = true
                notes.append("pairing flag cleared")
            }
        }
        if state == .normal, !pairingMode, endedWindowId != nil {
            takeoverAdvertRead = true
            if ownerChanged, let generation, generation == endedWindowId, verifiedWindowId != generation {
                verificationArmed = true
                verifiedWindowId = generation
                notes.append("owner_changed for window \(generation) — one verification attempt")
            }
        }
        return MentraLivePairingTransition(
            effect: effect,
            stateChanged: changed,
            note: notes.isEmpty ? "advert" : notes.joined(separator: "; ")
        )
    }

    /// The pause deadline may have passed.
    @discardableResult
    mutating func onTick(nowMs: Int) -> MentraLivePairingTransition {
        guard case let .pairingMode(current, endsAtMs) = state else { return none("not paused") }
        if nowMs < endsAtMs { return none("pause continues") }
        state = .normal
        pausedAtMs = nil
        endedWindowId = current
        takeoverAdvertRead = false
        return MentraLivePairingTransition(effect: .resume, stateChanged: true, note: "pause deadline passed")
    }

    /// One authentication-type failure (Android HCI 0x05/0x0F or bond removed, iOS CBError 14 or
    /// insufficient authentication/encryption). The intentional disconnect at window entry, the
    /// glasses' 0x14 refusals and anything while pairing mode is in effect never count.
    @discardableResult
    mutating func onAuthRejection(
        secureFirmware: Bool,
        explicitAttempt: Bool,
        nowMs: Int
    ) -> MentraLivePairingTransition {
        if !secureFirmware { return none("legacy firmware") }
        if explicitAttempt { return none("explicit attempt") }
        switch state {
        case .pairingMode: return none("pairing_mode in effect")
        case .rejected: return none("already rejected")
        case .normal: break
        }
        if advertShowsPairingMode(nowMs: nowMs) { return none("advertisement shows pairing mode") }
        if verificationArmed { return reject("owner_changed_verification_failed") }
        if !streak.record(nowMs: nowMs) { return none("counted toward the rejection streak") }
        return reject("auth_rejection_streak")
    }

    /// The verification attempt ended without an authentication verdict.
    @discardableResult
    mutating func onConnectAttemptFailed() -> MentraLivePairingTransition {
        guard verificationArmed else { return none("no verification") }
        verificationArmed = false
        return none("verification attempt failed without an auth verdict")
    }

    /// A session reached ready. An explicit pair clears `.rejected`.
    @discardableResult
    mutating func onSessionReady(explicitAttempt: Bool) -> MentraLivePairingTransition {
        streak.reset()
        verificationArmed = false
        endedWindowId = nil
        lastPairingAdvertAtMs = nil
        let clear = isPaused || (explicitAttempt && state == .rejected)
        guard clear else { return none("ready") }
        state = .normal
        pausedAtMs = nil
        return MentraLivePairingTransition(
            effect: .none,
            stateChanged: true,
            note: explicitAttempt ? "explicit pair succeeded" : "glasses admitted this phone"
        )
    }

    @discardableResult
    mutating func onForget() -> MentraLivePairingTransition {
        let changed = state != .normal
        clearRecord()
        deviceId = ""
        return MentraLivePairingTransition(effect: .none, stateChanged: changed, note: "forget")
    }

    private func advertShowsPairingMode(nowMs: Int) -> Bool {
        guard let at = lastPairingAdvertAtMs else { return false }
        let age = nowMs - at
        return age >= 0 && age <= Self.pairingAdvertFreshMs
    }

    private mutating func reject(_ reason: String) -> MentraLivePairingTransition {
        state = .rejected
        pausedAtMs = nil
        endedWindowId = nil
        verificationArmed = false
        streak.reset()
        return MentraLivePairingTransition(effect: .reject, stateChanged: true, note: reason)
    }

    private mutating func clearRecord() {
        resetInMemory()
        state = .normal
        endedWindowId = nil
        verifiedWindowId = nil
    }

    private mutating func resetInMemory() {
        pauseMs = 0
        pausedAtMs = nil
        verificationArmed = false
        lastPairingAdvertAtMs = nil
        takeoverAdvertRead = false
        streak.reset()
    }

    private func none(_ note: String) -> MentraLivePairingTransition {
        MentraLivePairingTransition(effect: .none, stateChanged: false, note: note)
    }

    /// UserDefaults hands back NSNumber; a String or other type is malformed and ignored.
    private static func intValue(_ value: Any?) -> Int? {
        if value is String { return nil }
        return (value as? NSNumber)?.intValue ?? (value as? Int)
    }
}
