package com.mentra.bluetoothsdk.streaming

import org.junit.Assert.*
import org.junit.Test

class StreamSessionStateTest {
    @Test fun readinessRequiresKnownProtocolAndProcessIdentity() {
        val state = StreamSessionState()
        state.ready("asg", null)
        assertFalse(state.supported)
        state.ready("asg", 2)
        assertFalse(state.supported)
        state.ready("", 1)
        assertFalse(state.supported)
        state.ready("asg", 1)
        assertTrue(state.supported)
    }

    @Test fun reconnectReconcilesTerminalStateWithoutHeartbeatTimeouts() {
        val state = StreamSessionState()
        state.ready("asg", 1)
        assertTrue(state.accept(event("asg", 1, false)))
        state.ready("asg", 1)
        assertEquals("stream", state.currentStreamId)
        assertTrue(state.accept(event("asg", 3, true)))
        assertNull(state.currentStreamId)
        assertFalse(state.accept(event("asg", 2, false)))
        assertNull(state.currentStreamId)
    }

    @Test fun restartRejectsOldStatusAndAcceptsNewStoppedSnapshot() {
        val state = StreamSessionState()
        state.ready("old", 1)
        assertTrue(state.accept(event("old", 8, false)))
        state.ready("new", 1)
        assertFalse(state.accept(event("old", 9, false)))
        assertTrue(state.accept(mapOf("sid" to "new", "revision" to 0, "terminal" to true)))
        assertNull(state.currentStreamId)
    }

    private fun event(sid: String, revision: Int, terminal: Boolean) =
        mapOf("sid" to sid, "revision" to revision, "streamId" to "stream", "terminal" to terminal)
}
