package com.mentra.crust.receivers

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.mentra.crust.CrustModule

/**
 * Receives incident-report requests and forwards them into React Native so
 * the app can file a normal incident through the existing mobile incident pipeline.
 */
class SubmitIncidentReportReceiver internal constructor(
  private val emitReport: (Map<String, Any>) -> Unit,
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

    emitReport(body)
  }
}
