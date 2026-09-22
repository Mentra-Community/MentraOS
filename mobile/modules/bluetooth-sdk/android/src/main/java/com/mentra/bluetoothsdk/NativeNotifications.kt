package com.mentra.bluetoothsdk

/** Desired notification-centre controls. Completion means submitted, not firmware-confirmed. */
data class NativeNotificationConfig(
    val enabled: Boolean = false,
    val autoDisplay: Boolean = true,
    val durationSeconds: Int = 5,
    val doNotDisturb: Boolean = false,
    val blockedApps: List<String> = emptyList(),
) {
    init { require(durationSeconds in 1..30) { "durationSeconds must be between 1 and 30" } }

    fun toMap(): Map<String, Any> = mapOf(
        "enabled" to enabled, "autoDisplay" to autoDisplay,
        "durationSeconds" to durationSeconds, "doNotDisturb" to doNotDisturb, "blockedApps" to blockedApps,
    )

    companion object {
        fun fromMap(value: Map<String, Any>) = NativeNotificationConfig(
            enabled = value["enabled"] as? Boolean ?: false,
            autoDisplay = value["autoDisplay"] as? Boolean ?: true,
            durationSeconds = (value["durationSeconds"] as? Number)?.toInt() ?: 5,
            doNotDisturb = value["doNotDisturb"] as? Boolean ?: false,
            blockedApps = (value["blockedApps"] as? List<*>)?.filterIsInstance<String>() ?: emptyList(),
        )
    }
}

/** Availability is independent from notification content access and firmware acknowledgement. */
data class NativeNotificationStatus(
    val supported: Boolean = false,
    val source: String = "unsupported",
    val authorization: String = "unknown",
    val state: String = "unavailable",
    val config: NativeNotificationConfig = NativeNotificationConfig(),
    val error: String = "",
) {
    fun toMap(): Map<String, Any> = mapOf(
        "supported" to supported, "source" to source, "authorization" to authorization,
        "state" to state, "config" to config.toMap(), "error" to error,
    )
}
