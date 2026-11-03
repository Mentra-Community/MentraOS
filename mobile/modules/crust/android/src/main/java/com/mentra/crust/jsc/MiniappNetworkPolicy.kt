package com.mentra.crust.jsc

/**
 * Which URLs miniapp code may open through the polyfill's network bridge. Miniapp code is
 * untrusted, so `fetch` and `WebSocket` reach only the network: never a `file:` URL (the
 * Mentra App's own files), a `content:` URI or any other local scheme. Mirrors iOS
 * `MiniappNetworkPolicy.swift` and the polyfill's own check, which miniapp code can skip by
 * calling the bridge directly.
 */
object MiniappNetworkPolicy {
    /** Leading C0 controls and spaces are skipped, as OkHttp's URL parser does. */
    private val SCHEME = Regex("^[\\u0000-\\u0020]*([A-Za-z][A-Za-z0-9+.-]*):")
    private val FETCH_SCHEMES = setOf("http", "https")
    private val WEB_SOCKET_SCHEMES = setOf("ws", "wss", "http", "https")

    const val FETCH_REFUSAL = "fetch: only http: and https: URLs are allowed"
    const val WEB_SOCKET_REFUSAL = "ws.open: only ws:, wss:, http: and https: URLs are allowed"

    /** The URL's scheme, lowercased, or null for a URL without one. */
    fun scheme(url: String): String? = SCHEME.find(url)?.groupValues?.get(1)?.lowercase()

    fun allowsFetch(url: String): Boolean = scheme(url) in FETCH_SCHEMES

    fun allowsWebSocket(url: String): Boolean = scheme(url) in WEB_SOCKET_SCHEMES
}
