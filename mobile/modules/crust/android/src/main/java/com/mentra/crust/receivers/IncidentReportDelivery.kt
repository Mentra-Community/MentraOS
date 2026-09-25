package com.mentra.crust.receivers

import android.util.Log

/**
 * Hands incident requests to the JS report service only while it is subscribed.
 *
 * Crust's native OnCreate is not enough: the JS listener starts later, from the
 * signed-in engine, and Expo drops events that no listener receives. Requests are
 * not queued; [deliver] returns false so the receiver can answer immediately.
 */
internal class IncidentReportDelivery {
  @Volatile private var emitter: ((Map<String, Any>) -> Unit)? = null
  @Volatile private var serviceReady = false

  /** Called from Crust OnCreate. A new JS runtime has not subscribed yet. */
  fun attach(emit: (Map<String, Any>) -> Unit) {
    serviceReady = false
    emitter = emit
  }

  /** Called from Crust OnDestroy. */
  fun detach() {
    serviceReady = false
    emitter = null
  }

  /** Called by the JS report service after subscribing and before unsubscribing. */
  fun setServiceReady(ready: Boolean) {
    serviceReady = ready
  }

  /** Returns true only when the request was handed to a subscribed JS report service. */
  fun deliver(request: Map<String, Any>): Boolean {
    val emit = emitter
    if (emit == null) {
      Log.w(TAG, "Incident report request not delivered: Crust module is not created")
      return false
    }
    if (!serviceReady) {
      Log.w(TAG, "Incident report request not delivered: report service is not started")
      return false
    }
    return try {
      emit(request)
      true
    } catch (e: Exception) {
      Log.e(TAG, "Error delivering incident report request", e)
      false
    }
  }

  private companion object {
    const val TAG = "SubmitIncidentReport"
  }
}
