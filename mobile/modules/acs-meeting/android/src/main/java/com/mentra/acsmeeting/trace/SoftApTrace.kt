package com.mentra.acsmeeting.trace

import android.os.SystemClock
import android.util.Log

/**
 * Correlated stage logging for the SoftAP calling pipeline (phone side).
 *
 * TEMPORARY DIAGNOSTIC. Every line carries the literal `SOFTAP_TRACE` marker so a single
 * `rg -n 'SOFTAP_TRACE'` finds all of them at cleanup time. Flip [ENABLED] to false to mute the
 * layer for a release without deleting call sites.
 *
 * The logcat tag is deliberately distinct from the module's `ACS-SPIKE` tag so that
 * `adb logcat -s SOFTAP-TRACE` isolates the whole SoftAP pipeline in one stream.
 *
 * The phone mints [traceId] when it starts the hotspot and passes it to the glasses in
 * `start_stream`. Both devices stamp the same id on every line, which is the only way to correlate
 * two logs whose clocks were never synchronised.
 */
object SoftApTrace {

    /** Master switch. Flip to false to mute the trace without removing call sites. */
    const val ENABLED = true

    /** Grep marker. Never build this by concatenation — a single grep must be exhaustive. */
    const val MARKER = "SOFTAP_TRACE"

    const val TAG = "SOFTAP-TRACE"

    private const val REDACTED = "<redacted>"

    /** Keys whose values must never reach logcat. Matched case-insensitively as substrings. */
    private val SENSITIVE_KEYS = listOf(
        "password", "passwd", "passphrase", "psk", "token", "secret",
        "credential", "authorization", "bearer", "meetingurl",
    )

    @Volatile
    private var traceId: String = ""

    @Volatile
    private var originMs: Long = 0L

    @Volatile
    private var lastStage: String = ""

    /** Mint a new trace id and reset the elapsed-time origin. Called when the hotspot request starts. */
    fun begin(id: String = newTraceId()): String {
        traceId = id
        originMs = SystemClock.elapsedRealtime()
        lastStage = ""
        return id
    }

    fun reset() {
        traceId = ""
        originMs = 0L
        lastStage = ""
    }

    fun traceId(): String = traceId

    /** Last stage successfully logged; use as failure context when reporting an error. */
    fun lastStage(): String = lastStage

    /** Short, collision-resistant enough for correlating one call's logs. */
    fun newTraceId(): String = java.lang.Long.toHexString(System.nanoTime() and 0xFFFFFFFFL)

    /**
     * Log one pipeline stage transition.
     *
     * @param stage stable snake_case stage name, e.g. `scoped_network_available`
     */
    fun stage(stage: String, vararg fields: Pair<String, Any?>) {
        if (!ENABLED) return
        lastStage = stage
        val elapsedMs = if (originMs == 0L) 0L else SystemClock.elapsedRealtime() - originMs
        Log.i(TAG, format(traceId, stage, elapsedMs, *fields))
    }

    /** Error-level variant so genuine failures survive a logcat level filter. */
    fun failure(stage: String, vararg fields: Pair<String, Any?>) {
        if (!ENABLED) return
        val elapsedMs = if (originMs == 0L) 0L else SystemClock.elapsedRealtime() - originMs
        Log.e(TAG, format(traceId, stage, elapsedMs, *fields, "afterStage" to lastStage))
    }

    /**
     * Pure formatter. Split out from [stage] so it can be unit tested without the Android logging
     * framework, which is not available to plain JVM tests in this module.
     */
    fun format(
        traceId: String,
        stage: String,
        elapsedMs: Long,
        vararg fields: Pair<String, Any?>,
    ): String = buildString {
        append('[').append(MARKER).append(']')
        if (traceId.isNotEmpty()) append(" traceId=").append(traceId)
        append(" stage=").append(stage)
        append(" elapsedMs=").append(elapsedMs)
        for ((key, value) in fields) {
            append(' ').append(key).append('=').append(sanitize(key, value))
        }
    }

    /**
     * Redact secrets outright and strip query strings from URLs. The local WHIP URL is genuinely
     * useful in a trace, but a URL carrying a watch token is not, so query and userinfo go.
     */
    fun sanitize(key: String, value: Any?): String {
        if (isSensitive(key)) return REDACTED
        if (value == null) return "null"

        val text = value.toString()
        if (text.isEmpty()) return "\"\""
        val cleaned = stripUrlSecrets(text)
        return if (cleaned.contains(' ')) "\"$cleaned\"" else cleaned
    }

    private fun isSensitive(key: String): Boolean {
        val lower = key.lowercase()
        return SENSITIVE_KEYS.any { lower.contains(it) }
    }

    /** Drop `?query`, `#fragment`, and `user:pass@` from anything URL-shaped. */
    private fun stripUrlSecrets(text: String): String {
        val schemeIndex = text.indexOf("://")
        if (schemeIndex < 0) return text

        var result = text
        val query = result.indexOf('?')
        if (query >= 0) result = result.substring(0, query) + "?" + REDACTED
        val fragment = result.indexOf('#')
        if (fragment >= 0) result = result.substring(0, fragment)

        val at = result.indexOf('@', schemeIndex + 3)
        if (at >= 0) {
            result = result.substring(0, schemeIndex + 3) + REDACTED + "@" + result.substring(at + 1)
        }
        return result
    }
}
