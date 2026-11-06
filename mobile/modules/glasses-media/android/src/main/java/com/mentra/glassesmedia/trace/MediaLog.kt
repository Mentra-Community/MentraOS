package com.mentra.glassesmedia.trace

import android.util.Log

/**
 * Logcat plus the app's JavaScript console, which bug reports upload. glasses-media and
 * acs-meeting import it as `Log`, so the relay, ingest, SoftAP and ACS traces reach a report.
 */
object MediaLog {
    /** Set by [com.mentra.glassesmedia.GlassesMediaRelayModule] while it exists. */
    @Volatile
    var sink: ((String) -> Unit)? = null

    fun i(tag: String, message: String): Int = write(Log.INFO, tag, message, null)

    fun w(tag: String, message: String, error: Throwable? = null): Int = write(Log.WARN, tag, message, error)

    fun e(tag: String, message: String, error: Throwable? = null): Int = write(Log.ERROR, tag, message, error)

    private fun write(priority: Int, tag: String, message: String, error: Throwable?): Int {
        val text = if (error == null) message else "$message\n${Log.getStackTraceString(error)}"
        val result = Log.println(priority, tag, text)
        val level = when (priority) {
            Log.ERROR -> "E"
            Log.WARN -> "W"
            else -> "I"
        }
        try {
            sink?.invoke("[$level/$tag] $text")
        } catch (_: Throwable) {
            // A log line must never break the media path that wrote it.
        }
        return result
    }
}
