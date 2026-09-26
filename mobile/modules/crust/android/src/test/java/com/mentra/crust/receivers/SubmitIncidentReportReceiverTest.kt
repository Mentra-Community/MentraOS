package com.mentra.crust.receivers

import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONObject
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class SubmitIncidentReportReceiverTest {
  @Before
  fun clearLogs() {
    ShadowLog.clear()
  }

  private fun receipts(): List<JSONObject> =
    ShadowLog.getLogsForTag("ReactNativeJS")
      .map { it.msg }
      .filter { it.startsWith("INCIDENT_REPORT_RESULT ") }
      .map { JSONObject(it.removePrefix("INCIDENT_REPORT_RESULT ")) }

  @Test
  fun forwardsReportMetadataAndPrimitiveExtras() {
    val events = mutableListOf<Map<String, Any>>()
    val receiver = SubmitIncidentReportReceiver { events.add(it) }
    receiver.onReceive(null, Intent("com.mentra.SUBMIT_INCIDENT_REPORT").apply {
      putExtra("alert_id", "request-1")
      putExtra("test_run_id", "run-1")
      putExtra("failure_message", "Update failed")
      putExtra("source", "mentra_automated_testing")
      putExtra("attempt", 2)
      putExtra("recoverable", true)
      putExtra("action", "spoofed")
      putExtra("timestamp", -1L)
      putExtra("unsupported", Uri.parse("content://unsupported"))
    })
    val event = events.single()
    assertEquals("com.mentra.SUBMIT_INCIDENT_REPORT", event["action"])
    assertEquals("request-1", event["alert_id"])
    assertEquals("run-1", event["test_run_id"])
    assertEquals("Update failed", event["failure_message"])
    assertEquals("mentra_automated_testing", event["source"])
    assertEquals(2, event["attempt"])
    assertEquals(true, event["recoverable"])
    assertTrue((event["timestamp"] as Long) > 0)
    assertFalse(event.containsKey("unsupported"))
  }

  @Test
  fun ignoresNullAndUnrelatedExplicitIntents() {
    val events = mutableListOf<Map<String, Any>>()
    val receiver = SubmitIncidentReportReceiver { events.add(it) }
    receiver.onReceive(null, null)
    receiver.onReceive(null, Intent("com.mentra.OTHER_ACTION"))
    assertTrue(events.isEmpty())
  }

  @Test
  fun deliveredRequestsLeaveTheReceiptToTheReportService() {
    val receiver = SubmitIncidentReportReceiver { true }
    receiver.onReceive(null, Intent("com.mentra.SUBMIT_INCIDENT_REPORT").putExtra("alert_id", "request-1"))
    assertTrue(receipts().isEmpty())
  }

  @Test
  fun undeliveredRequestGetsAnImmediateCorrelatedFailedReceipt() {
    val receiver = SubmitIncidentReportReceiver { false }
    receiver.onReceive(null, Intent("com.mentra.SUBMIT_INCIDENT_REPORT").apply {
      putExtra("alert_id", "request-1")
      putExtra("test_run_id", "run-1")
      putExtra("failure_code", "unpair_failed")
      putExtra("scenario_name", "no-glasses-android")
      putExtra("failure_message", "Crash during Unpair")
    })
    val receipt = receipts().single()
    assertEquals("request-1", receipt.getString("alert_id"))
    assertEquals("run-1", receipt.getString("test_run_id"))
    assertEquals("unpair_failed", receipt.getString("failure_code"))
    assertEquals("no-glasses-android", receipt.getString("scenario_name"))
    assertEquals("failed", receipt.getString("status"))
    assertEquals(SubmitIncidentReportReceiver.UNAVAILABLE_ERROR, receipt.getString("error"))
    assertFalse(receipt.has("report_id"))
    assertFalse(receipt.has("incident_id"))
    assertFalse(receipt.toString().contains("Crash during Unpair"))
  }

  @Test
  fun undeliveredReceiptUsesTheServiceCorrelationDefaults() {
    val receiver = SubmitIncidentReportReceiver { false }
    receiver.onReceive(null, Intent("com.mentra.SUBMIT_INCIDENT_REPORT").apply {
      putExtra("alert_id", " ")
      putExtra("test_run_id", "run-1")
      putExtra("failure_code", 7)
    })
    val receipt = receipts().single()
    assertEquals("run-1", receipt.getString("alert_id"))
    assertEquals("unknown", receipt.getString("failure_code"))
    assertFalse(receipt.has("scenario_name"))
  }

  @Test
  fun eachUndeliveredRetransmitGetsItsOwnReceiptAndNothingIsQueued() {
    val attempts = mutableListOf<Map<String, Any>>()
    val receiver = SubmitIncidentReportReceiver { attempts.add(it); false }
    val intent = Intent("com.mentra.SUBMIT_INCIDENT_REPORT").putExtra("alert_id", "request-1")
    receiver.onReceive(null, intent)
    receiver.onReceive(null, intent)
    assertEquals(2, attempts.size)
    assertEquals(listOf("request-1", "request-1"), receipts().map { it.getString("alert_id") })
  }

  @Test
  fun unsupportedActionsDoNotProduceReceipts() {
    val receiver = SubmitIncidentReportReceiver { false }
    receiver.onReceive(null, Intent("com.mentra.OTHER_ACTION"))
    assertTrue(receipts().isEmpty())
  }
}
