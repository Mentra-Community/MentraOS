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
