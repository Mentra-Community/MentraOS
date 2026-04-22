package com.mentra.core.receivers

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.mentra.core.Bridge

/**
 * Receives broadcasts from the external captions tester and forwards them into React Native so
 * the app can file a normal incident through the existing mobile incident pipeline.
 */
class CaptionsTesterIncidentReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null) {
            Bridge.log("CaptionsTesterIncidentReceiver: received null intent")
            return
        }

        val body = hashMapOf<String, Any>(
            "action" to (intent.action ?: "unknown"),
            "timestamp" to System.currentTimeMillis(),
        )

        intent.getStringExtra("failure_code")?.let { body["failure_code"] = it }
        intent.getStringExtra("failure_message")?.let { body["failure_message"] = it }
        intent.getStringExtra("test_run_id")?.let { body["test_run_id"] = it }
        intent.getStringExtra("scenario_name")?.let { body["scenario_name"] = it }
        intent.getStringExtra("source")?.let { body["source"] = it }

        intent.extras?.keySet()?.forEach { key ->
            if (body.containsKey(key)) {
                return@forEach
            }
            val value = intent.extras?.get(key) ?: return@forEach
            when (value) {
                is String, is Int, is Long, is Boolean, is Double, is Float -> body[key] = value
                else -> body[key] = value.toString()
            }
        }

        Bridge.sendTypedMessage("captions_tester_incident", body)
    }
}

