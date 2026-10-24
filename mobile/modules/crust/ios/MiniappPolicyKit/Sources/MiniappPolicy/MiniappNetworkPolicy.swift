import Foundation

/// Which URLs miniapp code may open through the polyfill's network bridge.
///
/// Miniapp code is untrusted, so `fetch` and `WebSocket` reach only the network.
/// URLSession also reads `file:` URLs, which would hand a miniapp the Mentra App's
/// own files, and `data:` URLs. Mirrors Android's `MiniappNetworkPolicy.kt` and the
/// polyfill's own check, which miniapp code can skip by calling the bridge directly.
public enum MiniappNetworkPolicy {
    public static let fetchRefusal = "fetch: only http: and https: URLs are allowed"
    public static let webSocketRefusal = "ws.open: only ws:, wss:, http: and https: URLs are allowed"

    private static let fetchSchemes: Set<String> = ["http", "https"]
    private static let webSocketSchemes: Set<String> = ["ws", "wss", "http", "https"]

    /// `fetch`, and every redirect it follows.
    public static func allowsFetch(_ url: URL) -> Bool {
        fetchSchemes.contains(url.scheme?.lowercased() ?? "")
    }

    public static func allowsWebSocket(_ url: URL) -> Bool {
        webSocketSchemes.contains(url.scheme?.lowercased() ?? "")
    }
}
