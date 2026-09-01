package com.mentra.bluetoothsdk

internal const val WIFI_FORGET_CORRELATED_PRIORITY_WINDOW_MS = 750L

internal fun wifiSsidIsValid(ssid: String): Boolean = ssid.trim().isNotEmpty()

internal sealed class ParsedWifiForgetResult {
    data class Dispatched(
        val connected: Boolean,
        val currentSsid: String?,
        val localIp: String?,
    ) : ParsedWifiForgetResult()

    data class Failure(val error: String) : ParsedWifiForgetResult()
}

internal data class ParsedSavedWifiNetworks(
    val networks: List<String>,
    val error: String?,
)

internal fun parseWifiForgetResult(
    expectedRequestId: String,
    expectedSsid: String,
    data: Map<String, Any>,
): ParsedWifiForgetResult? {
    if (data["requestId"] as? String != expectedRequestId) return null
    if (data["ssid"] as? String != expectedSsid) return null
    if (data["dispatched"] as? Boolean != true) {
        return ParsedWifiForgetResult.Failure(
            (data["error"] as? String)?.takeIf { it.isNotEmpty() } ?: "forget_dispatch_failed"
        )
    }
    return ParsedWifiForgetResult.Dispatched(
        connected = data["connected"] as? Boolean ?: false,
        currentSsid = data["currentSsid"] as? String,
        localIp = data["localIp"] as? String,
    )
}

internal fun parseSavedWifiNetworks(
    expectedRequestId: String,
    data: Map<String, Any>,
): ParsedSavedWifiNetworks? {
    if (data["requestId"] as? String != expectedRequestId) return null
    val networks =
        (data["networks"] as? List<*>)
            ?.mapNotNull { it as? String }
            ?.filter { it.trim().isNotEmpty() }
            ?.distinct()
            ?: emptyList()
    return ParsedSavedWifiNetworks(
        networks = networks,
        error = (data["error"] as? String)?.takeIf { it.isNotEmpty() },
    )
}

internal fun wifiForgetLegacyFallbackDelayMs(
    priorityDeadlineMs: Long,
    nowMs: Long,
): Long = (priorityDeadlineMs - nowMs).coerceAtLeast(0L)

internal fun wifiForgetFallbackStillApplies(
    scheduledRequestId: String,
    activeRequestId: String?,
): Boolean = scheduledRequestId == activeRequestId
