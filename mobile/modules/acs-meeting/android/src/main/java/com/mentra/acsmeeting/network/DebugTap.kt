// #region agent log
package com.mentra.acsmeeting.network

import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * TEMPORARY debug tap for session 538848. Delete with the rest of the instrumentation.
 *
 * Posts NDJSON to the developer host over `adb reverse tcp:7905 tcp:7905`. Loopback is unaffected
 * by the scoped SoftAP join, so this keeps reporting while the phone is dual-homed.
 */
internal object DebugTap {
    private const val ENDPOINT = "http://127.0.0.1:7905/ingest/5a9713c9-45ff-4d09-9435-2adc5db5e91d"
    private const val SESSION = "538848"

    /**
     * Run a read-only shell command (`ip rule`, `ip route`) and return its output, capped. Apps may
     * read the routing tables over netlink; anything denied comes back as the error text instead.
     */
    fun shell(command: String, maxChars: Int = 4_000): String =
        runCatching {
            val process = ProcessBuilder("sh", "-c", command).redirectErrorStream(true).start()
            val output = process.inputStream.bufferedReader().use { it.readText() }
            process.waitFor()
            output.trim().take(maxChars)
        }.getOrElse { "shell failed: ${it.message}" }

    private val pool =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "softap-debug-tap").apply { isDaemon = true }
        }

    fun log(hypothesisId: String, location: String, message: String, data: Map<String, Any?>) {
        val payload =
            JSONObject().apply {
                put("sessionId", SESSION)
                put("runId", "phone")
                put("hypothesisId", hypothesisId)
                put("location", location)
                put("message", message)
                put("timestamp", System.currentTimeMillis())
                put(
                    "data",
                    JSONObject().apply {
                        data.forEach { (key, value) -> put(key, value ?: JSONObject.NULL) }
                    },
                )
            }
        val body = payload.toString().toByteArray()
        pool.execute {
            runCatching {
                val connection = URL(ENDPOINT).openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.connectTimeout = 1_500
                connection.readTimeout = 1_500
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("X-Debug-Session-Id", SESSION)
                connection.outputStream.use { it.write(body) }
                connection.responseCode
                connection.disconnect()
            }
        }
    }
}
// #endregion
