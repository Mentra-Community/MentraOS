/// A usable default route is independent of the glasses' local-only Wi-Fi hotspot.
/// This classifies network paths; actual server reachability is established by the call.
public enum HotspotInternetPolicy {
    public static func route(satisfied: Bool, cellular: Bool, ethernet: Bool,
                             restoredWifiSSID: String? = nil, glassesSSID: String? = nil) -> String?
    {
        guard satisfied else { return nil }
        if cellular { return "cellular" }
        if ethernet { return "ethernet" }
        // Callers supply a Wi-Fi SSID only after releasing the glasses hotspot.
        if let restoredWifiSSID, let glassesSSID, !glassesSSID.isEmpty, !restoredWifiSSID.isEmpty, restoredWifiSSID != glassesSSID {
            return "wifi"
        }
        return nil
    }
}

/// One queue-confined route observation. Late SSID callbacks cannot settle a
/// newer path or session, and timeout/cancellation settle this observation once.
public final class HotspotInternetObservation {
    private let generation: Int
    private let glassesSSID: String?
    private var pathRevision = 0
    private var finished = false
    private var readingSSID = false
    private var settledReply: (() -> Void)?

    public init(generation: Int, glassesSSID: String?) {
        self.generation = generation
        self.glassesSSID = glassesSSID
    }

    public func beginPath(currentGeneration: Int) -> Int? {
        guard !finished, currentGeneration == generation else { return nil }
        pathRevision += 1
        return pathRevision
    }

    public func restoredWifiRoute(ssid: String?, pathRevision: Int, currentGeneration: Int) -> String? {
        guard !finished, currentGeneration == generation, pathRevision == self.pathRevision else { return nil }
        return HotspotInternetPolicy.route(satisfied: true, cellular: false, ethernet: false,
                                           restoredWifiSSID: ssid, glassesSSID: glassesSSID)
    }

    public func beginSSIDRead() -> Bool {
        guard !finished, !readingSSID else { return false }
        readingSSID = true
        return true
    }

    public func completeSSIDRead() {
        readingSSID = false
        let reply = settledReply
        settledReply = nil
        reply?()
    }

    public func afterSSIDRead(_ reply: @escaping () -> Void) {
        if readingSSID { settledReply = reply } else { reply() }
    }

    public func settle() -> Bool {
        guard !finished else { return false }
        finished = true
        return true
    }
}

/// Queue-confined cancellation owner. An old observation may finish joining its
/// native read after its replacement starts, but cannot clear that replacement.
public final class HotspotInternetObservationOwner {
    private var current: (observation: HotspotInternetObservation, cancel: () -> Void)?

    public init() {}

    public func install(_ observation: HotspotInternetObservation, cancel: @escaping () -> Void) {
        current?.cancel()
        current = (observation, cancel)
    }

    public func clear(_ observation: HotspotInternetObservation) {
        if current?.observation === observation { current = nil }
    }

    public func cancel() {
        current?.cancel()
    }
}

/// Queue-confined completion of one leave. Concurrent callers share cleanup;
/// the original ownership token is released before any caller can start again.
public final class HotspotLeaveCompletion {
    private var replies: [(Result<Void, Error>) -> Void] = []
    private var pending = true
    private let release: () -> Void

    public init(release: @escaping () -> Void) {
        self.release = release
    }

    public func append(_ reply: @escaping (Result<Void, Error>) -> Void) {
        replies.append(reply)
    }

    public func complete(_ result: Result<Void, Error>) {
        guard pending else { return }
        pending = false
        if case .success = result { release() }
        let current = replies
        replies.removeAll()
        current.forEach { $0(result) }
    }
}
