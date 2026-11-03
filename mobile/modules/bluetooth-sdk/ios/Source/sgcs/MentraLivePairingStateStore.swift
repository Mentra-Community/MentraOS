import Foundation

/// Process-wide owner of the `MentraLivePairingStateMachine`. It outlives each `MentraLive`
/// instance so a disconnect or SGC replacement keeps the pause and the rejection, persists the
/// record natively (never through the replayed settings), and publishes
/// `GlassesStatus.pairingState` plus `pairing_state_changed`. Mirrors Android
/// `MentraLivePairingStateStore`.
@MainActor
final class MentraLivePairingStateStore {
    static let shared = MentraLivePairingStateStore()

    /// The persisted record lives under one UserDefaults key; unknown inner keys are ignored.
    static let defaultsKey = "mentra_live_pairing_v4"

    private let defaults: UserDefaults
    private let publishes: Bool
    private var machine = MentraLivePairingStateMachine()
    private var restored = false

    /// `publishes == false` keeps tests away from DeviceStore and the bridge.
    init(defaults: UserDefaults = .standard, publishes: Bool = true) {
        self.defaults = defaults
        self.publishes = publishes
    }

    var state: MentraLivePairingState { machine.state }
    var allowsAutomaticReconnect: Bool { machine.allowsAutomaticReconnect }
    var isPaused: Bool { machine.isPaused }
    var isRejected: Bool { machine.state == .rejected }
    var verificationArmed: Bool { machine.verificationArmed }
    /// A window this phone paused for ended and its advertisement has not been read yet.
    var awaitingTakeoverCheck: Bool { machine.awaitingTakeoverCheck }

    func remainingPauseMs(nowMs: Int = MentraLivePairingStateStore.nowMs()) -> Int {
        machine.remainingPauseMs(nowMs: nowMs)
    }

    /// Restore once per process. Later calls only republish the status field.
    @discardableResult
    func ensureRestored(savedDeviceId: String, nowMs: Int = MentraLivePairingStateStore.nowMs()) -> MentraLivePairingTransition? {
        if restored {
            publish(emitEvent: false)
            return nil
        }
        restored = true
        var values = defaults.dictionary(forKey: Self.defaultsKey) ?? [:]
        for key in MentraLivePairingStateMachine.legacyKeys {
            if let legacy = defaults.object(forKey: key) { values[key] = legacy }
        }
        let transition = machine.restore(values: values, savedDeviceId: savedDeviceId, nowMs: nowMs)
        for key in MentraLivePairingStateMachine.legacyKeys {
            defaults.removeObject(forKey: key)
        }
        persist()
        publish()
        Bridge.log("PAIRFLOW: pairing_state restore note=\(transition.note) state=\(describe())")
        return transition
    }

    /// Run one machine input, persist the record, and publish when the public state changed.
    @discardableResult
    func update(
        _ source: String,
        _ input: (inout MentraLivePairingStateMachine) -> MentraLivePairingTransition
    ) -> MentraLivePairingTransition {
        let before = machine.state
        let beforeRecord = machine.persisted() as NSDictionary
        let transition = input(&machine)
        // Duplicate-reporting scans feed every advertisement through here.
        if !beforeRecord.isEqual(to: machine.persisted()) { persist() }
        if machine.state != before { publish() }
        if transition.effect != .none || machine.state != before {
            Bridge.log(
                "PAIRFLOW: pairing_state source=\(source) effect=\(transition.effect) note=\(transition.note) state=\(describe())"
            )
        }
        return transition
    }

    func describe() -> String {
        switch machine.state {
        case .normal: return "normal"
        case let .pairingMode(windowId, endsAtMs): return "pairing_mode(window=\(windowId), endsAtMs=\(endsAtMs))"
        case .rejected: return "pairing_rejected"
        }
    }

    /// Drops the in-memory state as a process restart would. Persisted values stay.
    func resetForTest() {
        machine = MentraLivePairingStateMachine()
        restored = false
    }

    nonisolated static func nowMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    private func persist() {
        var stored = defaults.dictionary(forKey: Self.defaultsKey) ?? [:]
        for key in MentraLivePairingStateMachine.keys {
            stored.removeValue(forKey: key)
        }
        for (key, value) in machine.persisted() {
            stored[key] = value
        }
        if stored.isEmpty {
            defaults.removeObject(forKey: Self.defaultsKey)
        } else {
            defaults.set(stored, forKey: Self.defaultsKey)
        }
    }

    private func publish(emitEvent: Bool = true) {
        guard publishes else { return }
        let map = machine.state.toMap()
        DeviceStore.shared.apply("glasses", "pairingState", map)
        if emitEvent {
            Bridge.sendTypedMessage("pairing_state_changed", body: ["state": map])
        }
    }
}
