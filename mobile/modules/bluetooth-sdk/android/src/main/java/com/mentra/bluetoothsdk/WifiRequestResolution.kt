package com.mentra.bluetoothsdk

internal fun wifiSsidIsValid(ssid: String): Boolean = ssid.trim().isNotEmpty()

/** Validate raw fields before JSON convenience getters can coerce numbers or erase presence. */
internal fun wifiResponseEnvelopeIsValid(values: Map<String, Any>, allowLegacy: Boolean): Boolean {
    if (values.containsKey("connected") && values["connected"] !is Boolean) return false
    if (values.containsKey("dispatched") && values["dispatched"] !is Boolean) return false
    val hasTuple = listOf("protocol_version", "requestId", "sid").any(values::containsKey)
    if (!hasTuple) return allowLegacy && !values.containsKey("outcome")
    return (values["protocol_version"] as? Number)?.toDouble() == 1.0 &&
        (values["requestId"] as? String)?.isNotBlank() == true &&
        (values["sid"] as? String)?.isNotBlank() == true &&
        !values.containsKey("dispatched")
}

internal const val WIFI_CAPABILITY_NEGOTIATION_TIMEOUT_CODE = "capability_negotiation_timeout"

internal sealed class WifiProtocolCapability {
    data object Unknown : WifiProtocolCapability()

    data class Supported(val version: Int) : WifiProtocolCapability()

    data object Unsupported : WifiProtocolCapability()

    data object Legacy : WifiProtocolCapability()
}

internal enum class WifiRequestMode {
    DISCOVERING,
    MODERN,
    LEGACY,
    UNSUPPORTED,
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
        if (raw == null) return WifiProtocolCapability.Legacy
        return if (raw is Number && raw.toDouble() == 1.0 && sessionId.isNotEmpty()) {
            WifiProtocolCapability.Supported(1)
        } else WifiProtocolCapability.Unsupported
    }

    private fun requestMode(capability: WifiProtocolCapability): WifiRequestMode =
        when (capability) {
            WifiProtocolCapability.Unknown -> WifiRequestMode.DISCOVERING
            is WifiProtocolCapability.Supported -> WifiRequestMode.MODERN
            WifiProtocolCapability.Legacy -> WifiRequestMode.LEGACY
            WifiProtocolCapability.Unsupported -> WifiRequestMode.UNSUPPORTED
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
    if (!wifiSsidIsValid(ssid)) return null
    val modernOutcome = WifiForgetOutcome.fromWire(outcome)
    if (requestId.isNotEmpty() && sid.isNotEmpty() && protocolVersion == 1 &&
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
    if (requestId.isEmpty() && sid.isEmpty() && protocolVersion == 0 && outcome.isEmpty() && legacyDispatched != null) {
        return buildMap {
            put("mode", "legacy")
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
    val ssid: String,
    val outcome: WifiForgetOutcome,
    val connected: Boolean?,
    val currentSsid: String?,
    val localIp: String?,
    val error: String? = null,
) {
    internal fun toMap(): Map<String, Any> =
        buildMap {
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
    val outcome: SavedWifiNetworksOutcome,
    val networks: List<String>,
    val error: String? = null,
) {
    internal fun toMap(): Map<String, Any> =
        buildMap {
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
    if (capabilityVersion != 1 || expectedRequestId.isEmpty() || expectedSid.isEmpty()) return null
    if (data["requestId"] as? String != expectedRequestId) return null
    if (data["sid"] as? String != expectedSid) return null
    if (data["ssid"] as? String != expectedSsid) return null
    if ((data["protocolVersion"] as? Number)?.toDouble() != 1.0) return null
    val outcome = WifiForgetOutcome.fromWire(data["outcome"] as? String ?: return null) ?: return null
    if (outcome == WifiForgetOutcome.LEGACY_UNVERIFIED) return null
    return WifiForgetResult(
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
    if (capabilityVersion != 1 || expectedRequestId.isEmpty() || expectedSid.isEmpty()) return null
    if (data["requestId"] as? String != expectedRequestId) return null
    if (data["sid"] as? String != expectedSid) return null
    if ((data["protocolVersion"] as? Number)?.toDouble() != 1.0) return null
    val outcome =
        SavedWifiNetworksOutcome.fromWire(data["outcome"] as? String ?: return null) ?: return null
    val rawNetworks = data["networks"] as? List<*> ?: return null
    if (rawNetworks.any { it !is String }) return null
    if (outcome != SavedWifiNetworksOutcome.CONFIRMED && rawNetworks.isNotEmpty()) return null
    val networks = rawNetworks.map { it as String }.filter { it.trim().isNotEmpty() }.distinct()
    return SavedWifiNetworksResult(
        outcome = outcome,
        networks = networks,
        error = (data["error"] as? String)?.takeIf { it.isNotEmpty() },
    )
}

internal fun legacyWifiForgetResult(
    ssid: String,
): WifiForgetResult {
    return WifiForgetResult(
        ssid = ssid,
        outcome = WifiForgetOutcome.LEGACY_UNVERIFIED,
        connected = null,
        currentSsid = null,
        localIp = null,
    )
}
