import Foundation

/// Settles a bounded wait exactly once, from whichever comes first: the work or the timeout.
final class BoundedWaitResolver<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Never>?

    fileprivate init(_ continuation: CheckedContinuation<T, Never>) {
        self.continuation = continuation
    }

    /// True once the wait has settled. Work that finds it settled should skip its side effects.
    var isSettled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return continuation == nil
    }

    /// Settle with `value`. Later calls are ignored.
    func resolve(_ value: T) {
        lock.lock()
        let pending = continuation
        continuation = nil
        lock.unlock()
        pending?.resume(returning: value)
    }
}

/// Run `start`, which must eventually call `resolve` on the resolver it receives, and settle with
/// `timeoutValue` if it has not done so within `timeout` seconds. Never throws.
func withBoundedWait<T>(
    timeout: TimeInterval,
    timeoutValue: T,
    timerQueue: DispatchQueue = .global(qos: .userInitiated),
    _ start: (BoundedWaitResolver<T>) -> Void
) async -> T {
    await withCheckedContinuation { continuation in
        let resolver = BoundedWaitResolver(continuation)
        timerQueue.asyncAfter(deadline: .now() + timeout) {
            resolver.resolve(timeoutValue)
        }
        start(resolver)
    }
}
