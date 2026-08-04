import Foundation

public enum ScanStopReason {
    case completed
    case cancelled
    case error
}

@MainActor
public final class ScanSession {
    private let stopAction: () -> Void
    private var stopped = false

    init(stopAction: @escaping () -> Void) {
        self.stopAction = stopAction
    }

    public func stop() {
        guard !stopped else { return }
        stopped = true
        stopAction()
    }

    func markStopped() {
        stopped = true
    }
}
