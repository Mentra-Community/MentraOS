import Foundation

public enum ScanStopReason {
    case completed
    case cancelled
    case error
}

/// A non-fatal explanation for an empty scan; it does not establish app ownership.
public struct ScanDiagnostic: Equatable {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
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
