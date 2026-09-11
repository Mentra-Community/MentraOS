package com.mentra.bluetoothsdk

sealed interface WifiStatus {
    val state: String

    fun toMap(): Map<String, Any> =
        when (this) {
            is Connected -> {
                val values =
                    mutableMapOf<String, Any>(
                        "state" to state,
                        "ssid" to ssid,
                    )
                localIp?.let { values["localIp"] = it }
                values
            }
            Disconnected -> mapOf("state" to state)
        }

    fun toEventMap(): Map<String, Any> =
        toMap() + mapOf("type" to "wifi_status_change")

    object Disconnected : WifiStatus {
        override val state: String = "disconnected"
    }

    data class Connected(
        val ssid: String,
        val localIp: String?,
    ) : WifiStatus {
        override val state: String = "connected"
    }

    companion object {
        internal fun fromMap(values: Map<String, Any>): WifiStatus? {
            val wifiValues = (values["wifi"] as? Map<*, *>)?.stringKeyedMap() ?: values
            return when (stringValue(wifiValues, "state")?.lowercase()) {
                "connected" -> connectedFrom(wifiValues)
                "disconnected" -> Disconnected
                else -> null
            }
        }

        internal fun fromStoreMap(values: Map<String, Any>): WifiStatus? {
            val connected = boolValue(values, "wifiConnected") ?: return null
            return fromStoreFields(
                connected = connected,
                ssid = stringValue(values, "wifiSsid"),
                localIp = stringValue(values, "wifiLocalIp"),
            )
        }

        internal fun fromStoreFields(connected: Boolean, ssid: String?, localIp: String?): WifiStatus? {
            if (!connected) return Disconnected
            val nonEmptySsid = ssid?.trim()?.takeIf { it.isNotEmpty() }
            val nonEmptyLocalIp = localIp?.trim()?.takeIf { it.isNotEmpty() }
            return nonEmptySsid?.let { Connected(it, nonEmptyLocalIp) }
        }

        private fun connectedFrom(values: Map<String, Any>): WifiStatus? =
            fromStoreFields(
                connected = true,
                ssid = stringValue(values, "ssid"),
                localIp = stringValue(values, "localIp"),
            )
    }
}

data class WifiStatusEvent @JvmOverloads constructor(
    val status: WifiStatus,
    /**
     * Glasses-reported provisioning failure reason when THIS event is the verdict of a
     * failed connect attempt; null for routine link-state updates. An attempt property,
     * not a link property — which is why it lives on the event and not on [WifiStatus]:
     * "connect_timeout" arrives with a disconnected status (never associated), while
     * "connected_to_other_network" arrives with a *connected* status — the attempt
     * failed and Android's auto-join left the glasses on (or returned them to) a
     * different SSID than requested, so the link is genuinely up while the request
     * genuinely failed. Sent by ASG client builds that include the WiFi error
     * surfacing (v40+); older glasses never set it.
     */
    val error: String? = null,
) {
    internal constructor(values: Map<String, Any>) : this(
        WifiStatus.fromMap(values) ?: WifiStatus.Disconnected,
        stringValue(values, "error")?.takeIf { it.isNotEmpty() },
    )
    internal constructor(connected: Boolean, ssid: String?, localIp: String?) : this(
        WifiStatus.fromStoreFields(connected, ssid, localIp) ?: WifiStatus.Disconnected
    )

    val values: Map<String, Any>
        get() = status.toEventMap() + (error?.let { mapOf("error" to it) } ?: emptyMap())
}

sealed interface HotspotStatus {
    val state: String

    fun toMap(): Map<String, Any> =
        when (this) {
            is Enabled ->
                mapOf(
                    "state" to state,
                    "ssid" to ssid,
                    "password" to password,
                    "localIp" to localIp,
                )
            Disabled -> mapOf("state" to state)
        }

    fun toEventMap(): Map<String, Any> =
        toMap() + mapOf("type" to "hotspot_status_change")

    object Disabled : HotspotStatus {
        override val state: String = "disabled"
    }

    data class Enabled(
        val ssid: String,
        val password: String,
        val localIp: String,
    ) : HotspotStatus {
        override val state: String = "enabled"
    }

    companion object {
        internal fun fromMap(values: Map<String, Any>): HotspotStatus? {
            val hotspotValues = (values["hotspot"] as? Map<*, *>)?.stringKeyedMap() ?: values
            return when (stringValue(hotspotValues, "state")?.lowercase()) {
                "enabled" -> enabledFrom(hotspotValues)
                "disabled" -> Disabled
                else -> null
            }
        }

        internal fun fromStoreMap(values: Map<String, Any>): HotspotStatus? {
            val enabled = boolValue(values, "hotspotEnabled") ?: return null
            return fromStoreFields(
                enabled = enabled,
                ssid = stringValue(values, "hotspotSsid"),
                password = stringValue(values, "hotspotPassword"),
                localIp = stringValue(values, "hotspotGatewayIp"),
            )
        }

        internal fun fromStoreFields(
            enabled: Boolean,
            ssid: String?,
            password: String?,
            localIp: String?,
        ): HotspotStatus? {
            if (!enabled) return Disabled
            val nonEmptySsid = ssid?.trim()?.takeIf { it.isNotEmpty() }
            val nonEmptyPassword = password?.trim()?.takeIf { it.isNotEmpty() }
            val nonEmptyLocalIp = localIp?.trim()?.takeIf { it.isNotEmpty() }
            return if (nonEmptySsid != null && nonEmptyPassword != null && nonEmptyLocalIp != null) {
                Enabled(nonEmptySsid, nonEmptyPassword, nonEmptyLocalIp)
            } else {
                null
            }
        }

        private fun enabledFrom(values: Map<String, Any>): HotspotStatus? =
            fromStoreFields(
                enabled = true,
                ssid = stringValue(values, "ssid"),
                password = stringValue(values, "password"),
                localIp = stringValue(values, "localIp"),
            )
    }
}

data class HotspotStatusEvent(
    val status: HotspotStatus,
) {
    internal constructor(values: Map<String, Any>) : this(HotspotStatus.fromMap(values) ?: HotspotStatus.Disabled)
    internal constructor(enabled: Boolean, ssid: String?, password: String?, localIp: String?) : this(
        HotspotStatus.fromStoreFields(enabled, ssid, password, localIp) ?: HotspotStatus.Disabled
    )

    val values: Map<String, Any> get() = status.toEventMap()
}

data class HotspotErrorEvent(
    val values: Map<String, Any>,
) {
    val message: String? get() = stringValue(values, "errorMessage")
    val timestamp: Long? get() = longValue(values, "timestamp")
}
