import Foundation

/// Whether the user has to do anything to get glasses audio working (`GlassesAudioSetupState` in
/// BluetoothSdk.types.ts). Published as `GlassesStatus.audioSetup` and `audio_setup_changed`.
/// Same map encoding as Android `GlassesAudioSetupState`.
enum GlassesAudioSetupState: Equatable {
    /// No glasses session.
    case idle
    /// This platform and glasses need no user step for audio.
    case notApplicable
    /// The link is up, audio is not, and the SDK still expects audio to come up on its own.
    case connecting
    /// Classic audio to these glasses is up.
    case connected
    /// Audio did not come up on its own. The user connects it in system Bluetooth settings.
    case needsUser(action: String)

    static let connectInSettingsAction = "connect_in_settings"
    static let needsUserConnectInSettings = GlassesAudioSetupState.needsUser(action: connectInSettingsAction)

    var name: String {
        switch self {
        case .idle: return "idle"
        case .notApplicable: return "not_applicable"
        case .connecting: return "connecting"
        case .connected: return "connected"
        case .needsUser: return "needs_user"
        }
    }

    /// Native map encoding: `{"state": "needs_user", "action": "connect_in_settings"}`.
    func toMap() -> [String: Any] {
        if case let .needsUser(action) = self {
            return ["state": name, "action": action]
        }
        return ["state": name]
    }

    init?(map: Any?) {
        guard let map = map as? [String: Any], let state = map["state"] as? String else { return nil }
        switch state {
        case "idle": self = .idle
        case "not_applicable": self = .notApplicable
        case "connecting": self = .connecting
        case "connected": self = .connected
        case "needs_user":
            self = .needsUser(action: map["action"] as? String ?? Self.connectInSettingsAction)
        default: return nil
        }
    }

    /// Glasses without a driver-specific rule (every model except Mentra Live today): no user
    /// step while the glasses are ready.
    static func modelDefault(ready: Bool) -> GlassesAudioSetupState {
        ready ? .notApplicable : .idle
    }
}

/// When the SDK started waiting for audio. Recorded when the session becomes ready.
enum GlassesAudioSetupPhase: Equatable {
    /// Readiness completed an explicit pairing attempt. `autoAudio` is this session's
    /// `pairing_info.auto_audio`; old firmware never sends it.
    case pairing(autoAudio: Bool)
    /// Any other readiness, and audio lost after `connected`.
    case reconnect

    var logName: String {
        switch self {
        case let .pairing(autoAudio): return autoAudio ? "pairing_auto_audio" : "pairing"
        case .reconnect: return "reconnect"
        }
    }
}

struct GlassesAudioSetupInputs: Equatable {
    var sessionReady: Bool
    /// A `classic_link` report arrived in this BLE session.
    var glassesReportsClassicLink: Bool
    var glassesA2dp: Bool
    var glassesHfp: Bool
    /// The phone's own signals: Classic bond, a connected HFP input or a matching Bluetooth output.
    var phoneAudioUp: Bool
    var phase: GlassesAudioSetupPhase
    var phaseStartedAtMs: Int
}

struct GlassesAudioSetupDecision: Equatable {
    let state: GlassesAudioSetupState
    /// When the state changes on its own if no input changes first. Nil when it never does.
    let nextDeadlineMs: Int?
}

/// iOS audio-setup rules for glasses that bring Classic audio up from the BLE pair. Pure: the
/// driver feeds inputs and arms one timer for `nextDeadlineMs`. Android has no user step and
/// reports `not_applicable` while ready.
enum GlassesAudioSetupPolicy {
    static let pairingAutoAudioWaitMs = 8000
    static let reconnectAudioGraceMs = 10000

    /// Either source is enough. A glasses report of both links down never vetoes the phone's view.
    static func audioUp(_ inputs: GlassesAudioSetupInputs) -> Bool {
        (inputs.glassesReportsClassicLink && (inputs.glassesA2dp || inputs.glassesHfp)) || inputs.phoneAudioUp
    }

    static func waitMs(_ phase: GlassesAudioSetupPhase) -> Int {
        switch phase {
        case let .pairing(autoAudio): return autoAudio ? pairingAutoAudioWaitMs : 0
        case .reconnect: return reconnectAudioGraceMs
        }
    }

    static func decide(_ inputs: GlassesAudioSetupInputs, nowMs: Int) -> GlassesAudioSetupDecision {
        guard inputs.sessionReady else { return GlassesAudioSetupDecision(state: .idle, nextDeadlineMs: nil) }
        if audioUp(inputs) { return GlassesAudioSetupDecision(state: .connected, nextDeadlineMs: nil) }
        // Glasses on the pairing protocol report classic_link. After setup they page their owner's
        // Classic link themselves, so a settings step can neither speed audio up nor fix it.
        if inputs.phase == .reconnect && inputs.glassesReportsClassicLink {
            return GlassesAudioSetupDecision(state: .connecting, nextDeadlineMs: nil)
        }
        // A report of A2DP and HFP both down does not shorten the wait: iOS may still be
        // bringing the link up.
        let deadline = inputs.phaseStartedAtMs + waitMs(inputs.phase)
        if nowMs < deadline {
            return GlassesAudioSetupDecision(state: .connecting, nextDeadlineMs: deadline)
        }
        return GlassesAudioSetupDecision(state: .needsUserConnectInSettings, nextDeadlineMs: nil)
    }
}

/// Per-driver audio-setup bookkeeping around `GlassesAudioSetupPolicy`: the phase, the glasses'
/// `classic_link` report for the current BLE session, and the last published state.
struct GlassesAudioSetupTracker {
    private(set) var phase: GlassesAudioSetupPhase = .reconnect
    private(set) var phaseStartedAtMs = 0
    private(set) var glassesReportsClassicLink = false
    private(set) var glassesA2dp = false
    private(set) var glassesHfp = false
    private(set) var state: GlassesAudioSetupState = .idle

    /// The session became ready.
    mutating func startPhase(_ phase: GlassesAudioSetupPhase, nowMs: Int) {
        self.phase = phase
        phaseStartedAtMs = nowMs
    }

    mutating func classicLink(a2dp: Bool, hfp: Bool) {
        glassesReportsClassicLink = true
        glassesA2dp = a2dp
        glassesHfp = hfp
    }

    /// The BLE session ended. The next session has not reported its Classic link yet.
    mutating func endSession() {
        glassesReportsClassicLink = false
        glassesA2dp = false
        glassesHfp = false
    }

    func inputs(sessionReady: Bool, phoneAudioUp: Bool) -> GlassesAudioSetupInputs {
        GlassesAudioSetupInputs(
            sessionReady: sessionReady,
            glassesReportsClassicLink: glassesReportsClassicLink,
            glassesA2dp: glassesA2dp,
            glassesHfp: glassesHfp,
            phoneAudioUp: phoneAudioUp,
            phase: phase,
            phaseStartedAtMs: phaseStartedAtMs
        )
    }

    /// Re-evaluates and records the new state. Losing audio after `connected` starts the
    /// reconnect wait again from `nowMs`.
    mutating func evaluate(sessionReady: Bool, phoneAudioUp: Bool, nowMs: Int) -> GlassesAudioSetupDecision {
        var decision = GlassesAudioSetupPolicy.decide(
            inputs(sessionReady: sessionReady, phoneAudioUp: phoneAudioUp), nowMs: nowMs
        )
        if state == .connected, sessionReady, decision.state != .connected {
            startPhase(.reconnect, nowMs: nowMs)
            decision = GlassesAudioSetupPolicy.decide(
                inputs(sessionReady: sessionReady, phoneAudioUp: phoneAudioUp), nowMs: nowMs
            )
        }
        state = decision.state
        return decision
    }
}
