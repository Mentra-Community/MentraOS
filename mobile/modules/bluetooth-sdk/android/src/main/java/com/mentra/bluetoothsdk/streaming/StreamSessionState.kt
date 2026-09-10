package com.mentra.bluetoothsdk.streaming

/** Observes glasses-owned streaming; delivery gaps never imply publisher failure. */
internal class StreamSessionState {
    @Volatile var processSessionId: String? = null
        private set
    @Volatile var currentStreamId: String? = null
        private set
    @Volatile var supported = false
        private set
    private var revision = -1L

    @Synchronized
    fun ready(sessionId: String?, controlVersion: Int?) {
        supported = controlVersion == 1 && !sessionId.isNullOrEmpty()
        if (processSessionId != sessionId) {
            currentStreamId = null
            revision = -1
        }
        processSessionId = sessionId
    }

    @Synchronized
    fun accept(values: Map<String, Any?>): Boolean {
        if (!supported || values["sid"] != processSessionId) return false
        val incomingRevision = (values["revision"] as? Number)?.toLong() ?: return false
        if (incomingRevision < revision) return false
        revision = incomingRevision
        currentStreamId = if (values["terminal"] == true) null else values["streamId"] as? String
        return true
    }
}
