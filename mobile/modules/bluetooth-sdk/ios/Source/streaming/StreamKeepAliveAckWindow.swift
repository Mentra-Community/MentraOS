import Foundation

/// Tracks a bounded, ordered window of stream keep-alive requests.
///
/// ACKs can arrive after a newer request has already been sent. Matching any
/// request still in the window proves that the stream transport is responsive;
/// requests older than the match can then be discarded as stale.
final class StreamKeepAliveAckWindow {
    private let maxTrackedAckIds: Int
    private let maxMissedAcks: Int
    private var pendingAckIds: [String] = []
    private(set) var missedAckCount = 0
    private(set) var armed = false
    private var didReportTimeout = false

    init(maxTrackedAckIds: Int, maxMissedAcks: Int) {
        precondition(maxTrackedAckIds > 0)
        precondition(maxMissedAcks > 0)
        self.maxTrackedAckIds = maxTrackedAckIds
        self.maxMissedAcks = maxMissedAcks
    }

    static func forStartedStream(maxTrackedAckIds: Int, maxMissedAcks: Int) -> StreamKeepAliveAckWindow {
        let window = StreamKeepAliveAckWindow(
            maxTrackedAckIds: maxTrackedAckIds,
            maxMissedAcks: maxMissedAcks
        )
        window.arm()
        return window
    }

    func arm() {
        armed = true
        resetPendingState()
    }

    func recordSent(ackId: String) {
        pendingAckIds.removeAll { $0 == ackId }
        pendingAckIds.append(ackId)
        if pendingAckIds.count > maxTrackedAckIds {
            pendingAckIds.removeFirst(pendingAckIds.count - maxTrackedAckIds)
        }
    }

    /// Records a heartbeat interval without a matching ACK. Returns the miss
    /// count once, when the reporting threshold is first reached.
    func recordTick() -> Int? {
        guard armed, !pendingAckIds.isEmpty else { return nil }
        missedAckCount += 1
        guard missedAckCount >= maxMissedAcks, !didReportTimeout else { return nil }
        didReportTimeout = true
        return missedAckCount
    }

    func acknowledge(ackId: String) -> Bool {
        guard let matchIndex = pendingAckIds.firstIndex(of: ackId) else { return false }
        pendingAckIds.removeFirst(matchIndex + 1)
        missedAckCount = 0
        didReportTimeout = false
        return true
    }

    private func resetPendingState() {
        pendingAckIds.removeAll(keepingCapacity: true)
        missedAckCount = 0
        didReportTimeout = false
    }
}
