package com.mentra.bluetoothsdk

internal fun wifiSsidIsValid(ssid: String): Boolean = ssid.trim().isNotEmpty()

internal fun wifiDelayedCallbackApplies(
    expectedEpoch: Long,
    currentEpoch: Long,
    isCurrentRequest: Boolean,
): Boolean = isCurrentRequest && expectedEpoch == currentEpoch

internal const val WIFI_CAPABILITY_NEGOTIATION_TIMEOUT_CODE = "capability_negotiation_timeout"

internal fun wifiCapabilityDiscoveryDeadlineRequired(mode: WifiRequestMode): Boolean =
    mode == WifiRequestMode.DISCOVERING

internal sealed class WifiProtocolCapability {
    data object Unknown : WifiProtocolCapability()

    data class Supported(val version: Int) : WifiProtocolCapability()

    data object Unsupported : WifiProtocolCapability()
}

internal enum class WifiRequestMode {
    DISCOVERING,
    MODERN,
    LEGACY,
}

internal data class WifiSessionRequestSnapshot(
    val mode: WifiRequestMode,
    val sessionId: String,
    val epoch: Long,
)

internal class WifiSessionCapabilities {
    var sessionId: String = ""
        private set
    var epoch: Long = 0
        private set
    var forgetResult: WifiProtocolCapability = WifiProtocolCapability.Unknown
        private set
    var savedNetworks: WifiProtocolCapability = WifiProtocolCapability.Unknown
        private set

    fun reset(sessionId: String = "") {
        epoch += 1
        this.sessionId = sessionId
        forgetResult = WifiProtocolCapability.Unknown
        savedNetworks = WifiProtocolCapability.Unknown
    }

    fun applyVersionInfo1(values: Map<String, Any>) {
        (values["sid"] as? String)?.takeIf { it.isNotEmpty() }?.let { sessionId = it }
        forgetResult = capability(values["wifiForgetResultVersion"])
        savedNetworks = capability(values["savedWifiNetworksVersion"])
    }

    fun forgetMode(): WifiRequestMode = requestMode(forgetResult)

    fun savedNetworksMode(): WifiRequestMode = requestMode(savedNetworks)

    fun savedNetworksRequestSnapshot(): WifiSessionRequestSnapshot =
        WifiSessionRequestSnapshot(savedNetworksMode(), sessionId, epoch)

    private fun capability(raw: Any?): WifiProtocolCapability {
        val version = (raw as? Number)?.toInt() ?: 0
        return if (version > 0) {
            WifiProtocolCapability.Supported(version)
        } else {
            WifiProtocolCapability.Unsupported
        }
    }

    private fun requestMode(capability: WifiProtocolCapability): WifiRequestMode =
        when (capability) {
            WifiProtocolCapability.Unknown -> WifiRequestMode.DISCOVERING
            is WifiProtocolCapability.Supported -> WifiRequestMode.MODERN
            WifiProtocolCapability.Unsupported -> WifiRequestMode.LEGACY
        }
}

enum class WifiForgetOutcome(val wireValue: String) {
    CONFIRMED("confirmed"),
    DISPATCHED("dispatched"),
    NOT_FOUND("not_found"),
    UNSUPPORTED("unsupported"),
    FAILED("failed"),
    LEGACY_UNVERIFIED("legacy_unverified");

    companion object {
        internal fun fromWire(value: String): WifiForgetOutcome? =
            entries.find { it.wireValue == value }
    }
}

internal fun normalizeWifiForgetResultEvent(
    requestId: String,
    sid: String,
    ssid: String,
    protocolVersion: Int,
    outcome: String,
    legacyDispatched: Boolean?,
    connected: Boolean?,
    currentSsid: String,
    localIp: String,
    error: String?,
): Map<String, Any>? {
    val modernOutcome = WifiForgetOutcome.fromWire(outcome)
    if (sid.isNotEmpty() && protocolVersion > 0 &&
        modernOutcome != null && modernOutcome != WifiForgetOutcome.LEGACY_UNVERIFIED
    ) {
        return buildMap {
            put("mode", "modern")
            put("requestId", requestId)
            put("sid", sid)
            put("ssid", ssid)
            put("protocolVersion", protocolVersion)
            put("outcome", modernOutcome.wireValue)
            connected?.let { put("connected", it) }
            if (currentSsid.isNotEmpty()) put("currentSsid", currentSsid)
            if (localIp.isNotEmpty()) put("localIp", localIp)
            error?.let { put("error", it) }
        }
    }
    if (legacyDispatched != null) {
        return buildMap {
            put("mode", "legacy")
            put("requestId", requestId)
            put("ssid", ssid)
            put("dispatched", legacyDispatched)
            connected?.let { put("connected", it) }
            if (currentSsid.isNotEmpty()) put("currentSsid", currentSsid)
            if (localIp.isNotEmpty()) put("localIp", localIp)
            error?.let { put("error", it) }
        }
    }
    return null
}

data class WifiForgetResult(
    val mode: String,
    val capabilityVersion: Int?,
    val requestId: String,
    val sid: String,
    val ssid: String,
    val outcome: WifiForgetOutcome,
    val connected: Boolean?,
    val currentSsid: String?,
    val localIp: String?,
    val error: String? = null,
) {
    internal fun toMap(): Map<String, Any> =
        buildMap {
            put("mode", mode)
            capabilityVersion?.let { put("capabilityVersion", it) }
            put("requestId", requestId)
            put("sid", sid)
            put("ssid", ssid)
            put("outcome", outcome.wireValue)
            connected?.let { put("connected", it) }
            currentSsid?.let { put("currentSsid", it) }
            localIp?.let { put("localIp", it) }
            error?.let { put("error", it) }
        }
}

enum class SavedWifiNetworksOutcome(val wireValue: String) {
    CONFIRMED("confirmed"),
    UNSUPPORTED("unsupported"),
    FAILED("failed");

    companion object {
        internal fun fromWire(value: String): SavedWifiNetworksOutcome? =
            entries.find { it.wireValue == value }
    }
}

data class SavedWifiNetworksResult(
    val mode: String,
    val capabilityVersion: Int?,
    val requestId: String,
    val sid: String,
    val outcome: SavedWifiNetworksOutcome,
    val networks: List<String>,
    val error: String? = null,
) {
    internal fun toMap(): Map<String, Any> =
        buildMap {
            put("mode", mode)
            capabilityVersion?.let { put("capabilityVersion", it) }
            put("requestId", requestId)
            put("sid", sid)
            put("outcome", outcome.wireValue)
            put("networks", networks)
            error?.let { put("error", it) }
        }
}

internal fun parseWifiForgetResult(
    expectedRequestId: String,
    expectedSid: String,
    expectedSsid: String,
    capabilityVersion: Int,
    data: Map<String, Any>,
): WifiForgetResult? {
    if (data["requestId"] as? String != expectedRequestId) return null
    if (data["sid"] as? String != expectedSid) return null
    if (data["ssid"] as? String != expectedSsid) return null
    if ((data["protocolVersion"] as? Number)?.toInt() != capabilityVersion) return null
    val outcome = WifiForgetOutcome.fromWire(data["outcome"] as? String ?: return null) ?: return null
    if (outcome == WifiForgetOutcome.LEGACY_UNVERIFIED) return null
    return WifiForgetResult(
        mode = "correlated",
        capabilityVersion = capabilityVersion,
        requestId = expectedRequestId,
        sid = expectedSid,
        ssid = expectedSsid,
        outcome = outcome,
        connected = data["connected"] as? Boolean,
        currentSsid = data["currentSsid"] as? String,
        localIp = data["localIp"] as? String,
        error = (data["error"] as? String)?.takeIf { it.isNotEmpty() },
    )
}

internal fun parseSavedWifiNetworks(
    expectedRequestId: String,
    expectedSid: String,
    capabilityVersion: Int,
    data: Map<String, Any>,
): SavedWifiNetworksResult? {
    if (data["requestId"] as? String != expectedRequestId) return null
    if (data["sid"] as? String != expectedSid) return null
    if ((data["protocolVersion"] as? Number)?.toInt() != capabilityVersion) return null
    val outcome =
        SavedWifiNetworksOutcome.fromWire(data["outcome"] as? String ?: return null) ?: return null
    val networks =
        (data["networks"] as? List<*>)
            ?.mapNotNull { it as? String }
            ?.filter { it.trim().isNotEmpty() }
            ?.distinct()
            ?: emptyList()
    return SavedWifiNetworksResult(
        mode = "correlated",
        capabilityVersion = capabilityVersion,
        requestId = expectedRequestId,
        sid = expectedSid,
        outcome = outcome,
        networks = networks,
        error = (data["error"] as? String)?.takeIf { it.isNotEmpty() },
    )
}

internal fun legacyWifiForgetResult(
    requestId: String,
    sid: String,
    ssid: String,
    event: WifiStatusEvent,
): WifiForgetResult {
    val connected = event.status as? WifiStatus.Connected
    return WifiForgetResult(
        mode = "legacy",
        capabilityVersion = null,
        requestId = requestId,
        sid = sid,
        ssid = ssid,
        outcome = WifiForgetOutcome.LEGACY_UNVERIFIED,
        connected = connected != null,
        currentSsid = connected?.ssid,
        localIp = connected?.localIp,
    )
}
