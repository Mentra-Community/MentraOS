import Foundation

/// One process-wide writer across OTA, gallery and native media sessions.
/// Callers release only after native association and owned cleanup have ended.
final class HotspotNetworkOwnership {
    static let shared = HotspotNetworkOwnership()
    private let lock = NSLock()
    private var owner: UUID?

    func acquire() -> UUID? {
        lock.lock(); defer { lock.unlock() }
        guard owner == nil else { return nil }
        let token = UUID()
        owner = token
        return token
    }

    func release(_ token: UUID) {
        lock.lock(); defer { lock.unlock() }
        if owner == token { owner = nil }
    }
}
