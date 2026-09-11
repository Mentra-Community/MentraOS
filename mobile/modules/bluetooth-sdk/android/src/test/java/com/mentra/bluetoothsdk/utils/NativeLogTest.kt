package com.mentra.bluetoothsdk.utils

import com.mentra.bluetoothsdk.Bridge
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class NativeLogTest {
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
}
