import Foundation

/// Tracks the SDK photo receiver that is hosted inside the phone app process.
///
/// The glasses need a LAN-reachable URL, but the phone-side BLE fallback relay
/// can upload to the same receiver over loopback. Keeping this tiny registry lets
/// the relay avoid stale Wi-Fi interface addresses after network changes.
enum LocalPhotoReceiverRegistry {
    private static let lock = NSLock()
    private static var activeUploadUrls: [URLComponents] = []

    static func register(_ uploadUrl: String) {
        guard let components = URLComponents(string: uploadUrl),
              isSupportedUploadUri(components)
        else {
            return
        }
        lock.lock()
        defer { lock.unlock() }
        if !activeUploadUrls.contains(where: { matchesRegisteredUploadUri($0, components) }) {
            activeUploadUrls.append(components)
        }
    }

    static func unregister() {
        lock.lock()
        defer { lock.unlock() }
        activeUploadUrls = []
    }

    static func isActive() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return !activeUploadUrls.isEmpty
    }

    static func loopbackUploadUrl(for webhookUrl: String?) -> String? {
        guard let webhookUrl, !webhookUrl.isEmpty else {
            return nil
        }
        lock.lock()
        let registeredUris = activeUploadUrls
        lock.unlock()
        guard !registeredUris.isEmpty,
              let candidate = URLComponents(string: webhookUrl),
              isSupportedUploadUri(candidate)
        else {
            return nil
        }

        for registered in registeredUris where matchesRegisteredUploadUri(candidate, registered) {
            var rewritten = URLComponents()
            rewritten.scheme = candidate.scheme
            rewritten.host = "127.0.0.1"
            rewritten.port = effectivePort(candidate)
            rewritten.percentEncodedPath = normalizedPath(candidate)
            rewritten.percentEncodedQuery = candidate.percentEncodedQuery
            rewritten.percentEncodedFragment = candidate.percentEncodedFragment
            return rewritten.string
        }
        return nil
    }

    private static func matchesRegisteredUploadUri(
        _ candidate: URLComponents, _ registered: URLComponents
    ) -> Bool {
        isSupportedUploadUri(candidate)
            && equalsIgnoreCase(candidate.scheme, registered.scheme)
            && equalsIgnoreCase(candidate.host, registered.host)
            && effectivePort(candidate) == effectivePort(registered)
            && normalizedPath(candidate) == normalizedPath(registered)
            && candidate.percentEncodedQuery == registered.percentEncodedQuery
            && candidate.percentEncodedFragment == registered.percentEncodedFragment
    }

    private static func isSupportedUploadUri(_ components: URLComponents) -> Bool {
        guard let scheme = components.scheme,
              scheme.caseInsensitiveCompare("http") == .orderedSame
              || scheme.caseInsensitiveCompare("https") == .orderedSame
        else {
            return false
        }
        guard let host = components.host, !host.isEmpty else {
            return false
        }
        return effectivePort(components) > 0 && normalizedPath(components) == "/upload"
    }

    private static func effectivePort(_ components: URLComponents) -> Int {
        if let port = components.port {
            return port
        }
        return components.scheme?.caseInsensitiveCompare("https") == .orderedSame ? 443 : 80
    }

    private static func normalizedPath(_ components: URLComponents) -> String {
        let path = components.percentEncodedPath
        return path.isEmpty ? "/" : path
    }

    private static func equalsIgnoreCase(_ first: String?, _ second: String?) -> Bool {
        guard let first, let second else {
            return first == nil && second == nil
        }
        return first.caseInsensitiveCompare(second) == .orderedSame
    }
}
