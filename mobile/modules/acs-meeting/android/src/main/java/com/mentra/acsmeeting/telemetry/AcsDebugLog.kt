package com.mentra.acsmeeting.telemetry

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

/** Debug-mode ingest. Never log tokens or full meeting URLs. */
internal object AcsDebugLog {
  private const val TAG = "ACS-SPIKE"
  private const val INGEST = "http://127.0.0.1:7331/ingest/3cce15b2-06a7-47f9-8f9c-924fd72ec258"
  private const val SESSION = "5e97f2"

  @Volatile var runId: String = "pre-fix"

  // Bounded + discard-oldest: an unreachable ingest must never grow a queue or
  // block a caller. The logcat line below is the lossless copy.
  private val pump = ThreadPoolExecutor(
    1, 1, 0L, TimeUnit.MILLISECONDS, ArrayBlockingQueue(512),
    { r -> Thread(r, "acs-dbg-log").apply { isDaemon = true } },
    ThreadPoolExecutor.DiscardOldestPolicy(),
  )

  fun emit(hypothesisId: String, location: String, message: String, data: Map<String, Any?>) {
    val obj = JSONObject()
    data.forEach { (key, value) -> obj.put(key, value ?: JSONObject.NULL) }
    emitJson(hypothesisId, location, message, obj)
  }

  fun emitJson(hypothesisId: String, location: String, message: String, data: JSONObject) {
    val body = JSONObject()
      .put("sessionId", SESSION)
      .put("runId", runId)
      .put("hypothesisId", hypothesisId)
      .put("location", location)
      .put("message", message)
      .put("timestamp", System.currentTimeMillis())
      .put("data", data)
    val line = body.toString()
    Log.i(TAG, "DBGJSON $line")
    pump.execute { post(line) }
  }

  /** WebRTC members hold Number/String/Boolean plus nested maps and arrays. */
  fun toJson(members: Map<String, Any?>): JSONObject {
    val out = JSONObject()
    for ((key, value) in members) out.put(key, wrap(value))
    return out
  }

  private fun wrap(value: Any?): Any = when (value) {
    null -> JSONObject.NULL
    is Number, is Boolean, is String -> value
    is Map<*, *> -> JSONObject().also { obj ->
      value.forEach { (k, v) -> obj.put(k.toString(), wrap(v)) }
    }
    is Array<*> -> JSONArray().also { arr -> value.forEach { arr.put(wrap(it)) } }
    is Iterable<*> -> JSONArray().also { arr -> value.forEach { arr.put(wrap(it)) } }
    else -> value.toString()
  }

  private fun post(line: String) {
    try {
      val conn = URL(INGEST).openConnection() as HttpURLConnection
      conn.requestMethod = "POST"
      conn.setRequestProperty("Content-Type", "application/json")
      conn.setRequestProperty("X-Debug-Session-Id", SESSION)
      conn.connectTimeout = 500
      conn.readTimeout = 500
      conn.doOutput = true
      conn.outputStream.use { it.write(line.toByteArray()) }
      conn.inputStream.close()
      conn.disconnect()
    } catch (_: Exception) {
    }
  }
}
