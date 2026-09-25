package com.mentra.crust.receivers

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.mentra.crust.CrustModule
import org.json.JSONObject

/**
 * Receives incident-report requests and forwards them into React Native so
 * the app can file a normal incident through the existing mobile incident pipeline.
 * When the JS report service is not subscribed, the request is not queued: the
 * caller immediately receives a correlated failed INCIDENT_REPORT_RESULT.
 */
class SubmitIncidentReportReceiver internal constructor(
  private val emitReport: (Map<String, Any>) -> Boolean,
) : BroadcastReceiver() {
  constructor() : this(CrustModule::emitSubmitIncidentReport)

  @Suppress("DEPRECATION")
  override fun onReceive(context: Context?, intent: Intent?) {
    if (intent?.action != "com.mentra.SUBMIT_INCIDENT_REPORT") {
      Log.w("SubmitIncidentReport", "Ignoring unsupported incident report action")
      return
    }

    val body =
      hashMapOf<String, Any>(
        "action" to (intent.action ?: "unknown"),
        "timestamp" to System.currentTimeMillis(),
      )

    intent.extras?.keySet()?.forEach { key ->
      if (body.containsKey(key)) {
        return@forEach
      }
      val value = intent.extras?.get(key) ?: return@forEach
      when (value) {
        is String, is Int, is Long, is Boolean, is Double, is Float -> body[key] = value
      }
    }

    if (!emitReport(body)) {
      Log.i(RESULT_LOG_TAG, "INCIDENT_REPORT_RESULT ${unavailableResult(body)}")
    }
  }

  internal companion object {
    // Callers read every receipt from the ReactNativeJS tag, where the JS report
    // service logs filed/skipped/failed results; keep this one on the same tag.
    const val RESULT_LOG_TAG = "ReactNativeJS"
    const val UNAVAILABLE_ERROR =
      "Incident report service is not running; the request was not queued. " +
        "Open the Mentra App, sign in, and send a new request."

    /** Mirrors SubmitIncidentReportService's IncidentReportResult correlation fields. */
    fun unavailableResult(request: Map<String, Any>): String {
      fun read(key: String) = (request[key] as? String)?.takeIf { it.isNotBlank() }
      val testRunId = read("test_run_id")
      return JSONObject()
        .apply {
          (read("alert_id") ?: testRunId)?.let { put("alert_id", it) }
          testRunId?.let { put("test_run_id", it) }
          put("failure_code", read("failure_code") ?: "unknown")
          read("scenario_name")?.let { put("scenario_name", it) }
          put("status", "failed")
          put("error", UNAVAILABLE_ERROR)
        }
        .toString()
    }
  }
}
