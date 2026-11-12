package com.mentra.bluetoothsdk

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Correlates `bes_crash_reported` commands with the glasses' `bes_crash_reported_ack`.
 *
 * Each call owns one waiter keyed by (incidentKey, reportId), so concurrent reports for
 * different incidents, or a stale ack for an earlier reportId, never settle each other.
 */
internal class BesCrashReportWaiters {
    private class Waiter(val incidentKey: String, val reportId: String) {
        val result = CompletableDeferred<Unit>()
    }

    private val waiters = mutableListOf<Waiter>()

    /** Registers before [send] so an immediate ack cannot be missed. */
    suspend fun await(incidentKey: String, reportId: String, timeoutMs: Long, send: () -> Unit) {
        val waiter = Waiter(incidentKey, reportId)
        synchronized(waiters) { waiters.add(waiter) }
        try {
            send()
            withTimeoutOrNull(timeoutMs) { waiter.result.await() }
                ?: throw BluetoothSdkException(
                    "request_timeout",
                    "bes_crash_reported for $incidentKey timed out waiting for the glasses ack.",
                )
        } finally {
            synchronized(waiters) { waiters.remove(waiter) }
        }
    }

    /**
     * Settles the waiters this ack answers. `ok:true` must echo the reportId; an `ok:false`
     * without a reportId rejects every waiter for that incidentKey. Returns the number settled.
     */
    fun onAck(values: Map<String, Any>): Int {
        val incidentKey = values["incidentKey"] as? String ?: return 0
        val reportId = (values["reportId"] as? String)?.takeIf { it.isNotEmpty() }
        val ok = values["ok"] == true
        val matched = synchronized(waiters) {
            waiters.filter {
                it.incidentKey == incidentKey && (it.reportId == reportId || (!ok && reportId == null))
            }
        }
        if (ok) {
            matched.forEach { it.result.complete(Unit) }
        } else {
            val error = (values["error"] as? String)?.takeIf { it.isNotEmpty() } ?: "unknown_error"
            matched.forEach {
                it.result.completeExceptionally(
                    BluetoothSdkException(
                        "bes_crash_report_rejected",
                        "Glasses rejected bes_crash_reported for $incidentKey: $error",
                    )
                )
            }
        }
        return matched.size
    }

    fun rejectAll(error: Throwable) {
        val snapshot = synchronized(waiters) { waiters.toList() }
        snapshot.forEach { it.result.completeExceptionally(error) }
    }
}
