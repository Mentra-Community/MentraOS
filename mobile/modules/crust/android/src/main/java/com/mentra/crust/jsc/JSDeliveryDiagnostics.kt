package com.mentra.crust.jsc

/** Metadata for one host PING. Never retains the envelope or exception message. */
internal class JSDeliveryDiagnostics(
    private val deliveryId: Long,
    private val contextId: Long?,
    private val clockMs: () -> Long,
    private val emit: (Map<String, Any?>) -> Unit,
) {
    private val enteredAtMs = clockMs()
    private var queuedAtMs: Long? = null
    private var startedAtMs: Long? = null

    fun entry() = report("native-entry")

    fun queued() {
        queuedAtMs = clockMs()
        report("queued")
    }

    fun started() {
        startedAtMs = clockMs()
        report("started")
    }

    fun finished(error: Throwable? = null) = report(if (error == null) "finished" else "evaluate-failed", error)

    fun dropped(reason: String, error: Throwable? = null) = report(reason, error)

    private fun report(phase: String, error: Throwable? = null) {
        val now = clockMs()
        emit(mapOf(
            "event" to "native-ping-delivery",
            "deliveryId" to deliveryId,
            "contextId" to contextId,
            "phase" to phase,
            "elapsedMs" to now - enteredAtMs,
            "queueWaitMs" to queuedAtMs?.let { (startedAtMs ?: now) - it },
            "evaluateMs" to startedAtMs?.let { now - it },
            "errorClass" to error?.javaClass?.simpleName,
            "causeClass" to error?.cause?.javaClass?.simpleName,
        ))
    }
}
