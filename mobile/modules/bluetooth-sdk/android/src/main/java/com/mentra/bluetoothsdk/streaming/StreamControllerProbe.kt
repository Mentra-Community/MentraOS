package com.mentra.bluetoothsdk.streaming

/** Process-scoped native ownership survives BLE reconnects, not app termination. */
internal object StreamControllerProbe {
    val controllerId: String = java.util.UUID.randomUUID().toString()

    fun response(values: Map<String, Any?>): Map<String, Any>? {
        if (values["protocolVersion"] != 1 || values["controllerId"] != controllerId) return null
        val streamId = (values["streamId"] as? String)?.takeIf { it.isNotEmpty() } ?: return null
        val probeId = (values["probeId"] as? String)?.takeIf { it.isNotEmpty() } ?: return null
        return mapOf("type" to "stream_controller_response", "protocolVersion" to 1,
            "controllerId" to controllerId, "streamId" to streamId, "probeId" to probeId)
    }
}
