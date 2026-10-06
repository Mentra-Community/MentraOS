import Foundation

/// Readiness belongs to an authenticated pair and a completed initialization attempt, never to
/// a gesture from one arm. A generation retires asynchronous setup when either arm is lost.
struct G2ConnectionSession {
    enum Side: String, CaseIterable {
        case left = "L"
        case right = "R"
    }

    private(set) var generation: UInt64 = 0
    private var initialized: Set<Side> = []
    private var authenticatedSides: Set<Side> = []
    private var authStarted = false
    private var setupComplete = false

    var isReady: Bool {
        initialized.count == 2 && authenticatedSides.count == 2 && setupComplete
    }

    func needsRecovery(attempt: UInt64) -> Bool {
        generation == attempt && !isReady
    }

    mutating func initialize(_ side: Side) {
        initialized.insert(side)
    }

    mutating func beginAuthentication() -> UInt64? {
        guard initialized.count == 2, !authStarted else { return nil }
        authStarted = true
        return generation
    }

    mutating func authenticated(_ side: Side, success: Bool) {
        guard authStarted else { return }
        if success { authenticatedSides.insert(side) }
        else { authenticatedSides.remove(side) }
    }

    mutating func completeSetup(generation: UInt64) {
        guard self.generation == generation, authStarted else { return }
        setupComplete = true
    }

    mutating func reset() {
        generation &+= 1
        initialized.removeAll()
        authenticatedSides.removeAll()
        authStarted = false
        setupComplete = false
    }
}

enum G2ConnectionTarget {
    /// A serial-scoped cached UUID identifies an arm even without a new advertisement. Nearby
    /// arms can share the G2_32 name fragment; only an advertisement's serial can select an
    /// uncached arm. Never fall back to names alone or another pair's cached identifiers.
    static func side(
        identifier: UUID, name: String?, advertisedSerial: String?, searchID: String,
        leftUUID: UUID?, rightUUID: UUID?
    ) -> G2ConnectionSession.Side? {
        guard !searchID.isEmpty, searchID != "NOT_SET" else { return nil }
        if identifier == leftUUID, identifier == rightUUID { return nil }
        if identifier == leftUUID { return .left }
        if identifier == rightUUID { return .right }
        guard let advertisedSerial, advertisedSerial.contains(searchID), let name else { return nil }
        if name.contains("_L_") { return .left }
        if name.contains("_R_") { return .right }
        return nil
    }
}

/// Normal pairing connects the arms sequentially. Surface a missing arm only after the
/// same partial link has persisted for three seconds, using monotonic time.
struct G2PartialConnection {
    static let noticeDelay: TimeInterval = 3
    private(set) var missingSide: G2ConnectionSession.Side?
    private var partialSince: TimeInterval = 0

    mutating func update(leftConnected: Bool, rightConnected: Bool, now: TimeInterval) {
        let missing: G2ConnectionSession.Side? = leftConnected == rightConnected
            ? nil : (leftConnected ? .right : .left)
        if missing != missingSide {
            missingSide = missing
            partialSince = now
        }
    }

    func visibleMissingSide(now: TimeInterval) -> G2ConnectionSession.Side? {
        now - partialSince >= Self.noticeDelay ? missingSide : nil
    }

    var timeoutError: String {
        switch missingSide {
        case .left: "errors:g2LeftArmUnavailable"
        case .right: "errors:g2RightArmUnavailable"
        case nil: "errors:g2ConnectionTimedOut"
        }
    }
}
