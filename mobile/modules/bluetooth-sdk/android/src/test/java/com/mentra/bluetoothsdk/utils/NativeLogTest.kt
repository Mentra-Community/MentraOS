package com.mentra.bluetoothsdk.utils

import com.mentra.bluetoothsdk.Bridge
import java.time.Duration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog
import org.robolectric.shadows.ShadowSystemClock

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class NativeLogTest {
    @Before
    fun resetForwardingBudget() {
        // The budget is process-wide static state, so a test that fills it would otherwise
        // change the outcome of every test that runs after it.
        NativeLog.resetForwardingBudgetForTest()
    }

    @Test
    fun tracingAnEventDoesNotRecursivelyTraceTheLog() {
        val events = mutableListOf<String>()
        val sink = Bridge.addEventSink { type, _ -> events.add(type) }
        try {
            Bridge.sendTypedMessage("head_up", mapOf("up" to true))
            assertEquals(listOf("log", "head_up"), events)
        } finally {
            Bridge.removeEventSink(sink)
        }
    }

    @Test
    fun nativeAndBridgeLogsReachTheSameEventAndLogcatOnce() {
        val messages = mutableListOf<String>()
        val sink = Bridge.addEventSink { type, body ->
            if (type == "log") messages.add(body["message"] as String)
        }
        try {
            ShadowLog.clear()
            NativeLog.e("MentraLive", "MTU negotiation failed", IllegalStateException("disconnected"))
            Bridge.log("Connection retry")
            assertEquals(2, messages.size)
            assertTrue(messages[0].startsWith("[E/MentraLive] MTU negotiation failed"))
            assertTrue(messages[0].contains("IllegalStateException: disconnected"))
            assertEquals("[I/Bridge] Connection retry", messages[1])
            assertEquals(1, ShadowLog.getLogsForTag("MentraLive").size)
            assertEquals(1, ShadowLog.getLogsForTag("Bridge").size)
        } finally {
            Bridge.removeEventSink(sink)
        }
    }

    @Test
    fun aFailingSinkDoesNotRecurseOrBlockOtherLogConsumers() {
        val failing = Bridge.addEventSink { _, _ -> throw IllegalStateException("dead listener") }
        var delivered = 0
        val healthy = Bridge.addEventSink { type, _ -> if (type == "log") delivered++ }
        try {
            NativeLog.d("MentraLive", "diagnostic")
            assertEquals(1, delivered)
        } finally {
            Bridge.removeEventSink(failing)
            Bridge.removeEventSink(healthy)
        }
    }

    @Test
    fun audioPayloadEventsAreNotTracedIntoTheLogStream() {
        val events = mutableListOf<String>()
        val sink = Bridge.addEventSink { type, _ -> events.add(type) }
        try {
            Bridge.sendTypedMessage("mic_pcm", mapOf("pcm" to ByteArray(320)))
            Bridge.sendTypedMessage("mic_lc3", mapOf("lc3" to ByteArray(60)))
            // Tracing these would emit a second bridge event per audio frame, and each one
            // pins a JNI global reference until JavaScript drains it.
            assertEquals(listOf("mic_pcm", "mic_lc3"), events)
        } finally {
            Bridge.removeEventSink(sink)
        }
    }

    @Test
    fun forwardingStopsAtTheBudgetSoAStalledJavaScriptThreadCannotExhaustTheReferenceTable() {
        var forwarded = 0
        val sink = Bridge.addEventSink { type, _ -> if (type == "log") forwarded++ }
        try {
            repeat(150) { NativeLog.i("MentraLive", "frame $it") }
            assertEquals(100, forwarded)
        } finally {
            Bridge.removeEventSink(sink)
        }
    }

    @Test
    fun theWindowAfterADropReportsHowManyMessagesWereWithheld() {
        val messages = mutableListOf<String>()
        val sink =
            Bridge.addEventSink { type, body ->
                if (type == "log") messages.add(body["message"] as String)
            }
        try {
            repeat(150) { NativeLog.i("MentraLive", "frame $it") }
            messages.clear()

            ShadowSystemClock.advanceBy(Duration.ofSeconds(2))
            NativeLog.i("MentraLive", "after the window rolled")

            assertEquals(2, messages.size)
            assertTrue(messages[0].contains("dropped 50 message(s)"))
            assertTrue(messages[0].contains("see logcat for the full output"))
            assertEquals("[I/MentraLive] after the window rolled", messages[1])
        } finally {
            Bridge.removeEventSink(sink)
        }
    }

    @Test
    fun everyMessageStillReachesLogcatWhileForwardingIsCapped() {
        val sink = Bridge.addEventSink { _, _ -> }
        try {
            ShadowLog.clear()
            repeat(150) { NativeLog.i("MentraLive", "frame $it") }
            // The cap exists to protect the JNI reference table, not to lose diagnostics.
            assertEquals(150, ShadowLog.getLogsForTag("MentraLive").size)
        } finally {
            Bridge.removeEventSink(sink)
        }
    }
}
