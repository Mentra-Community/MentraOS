package com.mentra.crust.jsc

import org.junit.Assert.*
import org.junit.Test

class JSDeliveryDiagnosticsTest {
    @Test fun `queue wait and evaluate duration are distinct`() {
        var now = 100L
        val events = mutableListOf<Map<String, Any?>>()
        val diagnostic = JSDeliveryDiagnostics(7, 2, { now }, { events += it })
        diagnostic.entry()
        now = 110
        diagnostic.queued()
        now = 310
        diagnostic.started()
        now = 350
        diagnostic.finished()

        assertEquals(listOf("native-entry", "queued", "started", "finished"), events.map { it["phase"] })
        assertEquals(200L, events.last()["queueWaitMs"])
        assertEquals(40L, events.last()["evaluateMs"])
        assertEquals(250L, events.last()["elapsedMs"])
        assertEquals(7L, events.last()["deliveryId"])
        assertEquals(2L, events.last()["contextId"])
    }

    @Test fun `failure includes exception identity without payload or message`() {
        val events = mutableListOf<Map<String, Any?>>()
        val diagnostic = JSDeliveryDiagnostics(1, 4, { 0L }, { events += it })
        val error = IllegalStateException("private-token user transcript", IllegalArgumentException("private-source"))
        diagnostic.entry()
        diagnostic.queued()
        diagnostic.started()
        diagnostic.finished(error)

        assertEquals("evaluate-failed", events.last()["phase"])
        assertEquals("IllegalStateException", events.last()["errorClass"])
        assertEquals("IllegalArgumentException", events.last()["causeClass"])
        assertFalse(events.toString().contains("private-"))
        assertFalse(events.toString().contains("transcript"))
    }

    @Test fun `missing context and rejected executor have explicit terminal events`() {
        for (reason in listOf("context-missing", "executor-rejected")) {
            val events = mutableListOf<Map<String, Any?>>()
            val diagnostic = JSDeliveryDiagnostics(9, null, { 0L }, { events += it })
            diagnostic.entry()
            diagnostic.dropped(reason)
            assertEquals(reason, events.last()["phase"])
            assertNull(events.last()["contextId"])
            assertNull(events.last()["evaluateMs"])
        }
    }
}
