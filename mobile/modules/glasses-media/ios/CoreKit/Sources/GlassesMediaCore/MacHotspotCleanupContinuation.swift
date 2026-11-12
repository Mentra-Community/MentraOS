import Foundation

/// Retain a real authorization restoration while this session's cleanup result
/// is still returning from its worker. All state belongs to the hotspot owner queue.
final class MacHotspotCleanupContinuation {
    private var restorationPending = false
    private let isCurrentCancelledSession: () -> Bool
    private let requestCleanup: () -> Void

    init(authorization: MacHotspotAuthorization, queue: DispatchQueue,
         isCurrentCancelledSession: @escaping () -> Bool, requestCleanup: @escaping () -> Void)
    {
        self.isCurrentCancelledSession = isCurrentCancelledSession
        self.requestCleanup = requestCleanup
        authorization.onRestored = { [weak self] in
            queue.async { [weak self] in
                guard let self, self.isCurrentCancelledSession() else { return }
                self.restorationPending = true
                self.requestCleanup()
            }
        }
    }

    func cleanupStarted() {
        restorationPending = false
    }

    func cleanupFailed() {
        guard restorationPending, isCurrentCancelledSession() else { return }
        restorationPending = false
        // A current restoration was not consumed by the failed worker attempt.
        // Resume only its owned cleanup, which rechecks live permission and SSID.
        requestCleanup()
    }
}
