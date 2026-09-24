package com.mentra.crust.receivers

import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class SubmitIncidentReportReceiverTest {
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
}
