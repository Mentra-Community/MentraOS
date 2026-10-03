/// Internet WHIP uses the same bounded STUN gather as the glasses publisher.
/// The local, host-only SoftAP receiver must still wait for complete gathering.
public struct WhipOfferGate {
    public enum Signal { case localDescriptionSet, serverReflexiveCandidate, gatheringComplete, deadline, stop }

    private var localSet = false
    private var ready = false
    private var posted = false
    private var stopped = false

    public init() {}

    /// True once per publisher, after both the description and a POST trigger exist.
    public mutating func observe(_ signal: Signal) -> Bool {
        switch signal {
        case .localDescriptionSet: localSet = true
        case .serverReflexiveCandidate, .gatheringComplete, .deadline: ready = true
        case .stop: stopped = true
        }
        guard localSet, ready, !posted, !stopped else { return false }
        posted = true
        return true
    }
}
