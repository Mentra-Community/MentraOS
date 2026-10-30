import Foundation

/// When to ask iOS again to join the glasses hotspot.
///
/// iOS accepts a hotspot configuration and then makes one short directed scan for it. When that
/// scan misses the glasses' beacon, iOS shows "Unable to join the network", stays on the current
/// Wi-Fi and still reports the configuration as applied. Only the phone's current network shows
/// that the join failed, so a request that has not put the phone on the hotspot after a few
/// seconds is made again, a bounded number of times, within the join's overall deadline.
public struct HotspotReapplyPolicy {
    /// Polls of the current network, half a second apart, before a request counts as missed.
    public let pollsBeforeReapply: Int
    /// Requests in one join, the first included.
    public let maxApplies: Int

    public init(pollsBeforeReapply: Int = 16, maxApplies: Int = 3) {
        self.pollsBeforeReapply = pollsBeforeReapply
        self.maxApplies = maxApplies
    }

    /// Whether to request the join again, with the phone not on the hotspot after `pollsSinceApply`
    /// polls of the `applies`-th request.
    public func shouldReapply(applies: Int, pollsSinceApply: Int) -> Bool {
        applies < maxApplies && pollsSinceApply >= pollsBeforeReapply
    }
}
