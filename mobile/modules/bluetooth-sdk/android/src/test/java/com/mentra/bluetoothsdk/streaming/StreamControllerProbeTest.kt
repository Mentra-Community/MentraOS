package com.mentra.bluetoothsdk.streaming

import org.junit.Assert.*
import org.junit.Test

class StreamControllerProbeTest {
    private fun probe() = mapOf<String, Any>("protocolVersion" to 1,
        "controllerId" to StreamControllerProbe.controllerId, "streamId" to "stream", "probeId" to "nonce")

    @Test fun answersCurrentProcessChallengeWithoutJsOrTimer() {
        val response = StreamControllerProbe.response(probe())!!
        assertEquals("stream_controller_response", response["type"])
        assertEquals("nonce", response["probeId"])
        assertEquals("stream", response["streamId"])
    }

    @Test fun rejectsPreviousProcessAndMalformedChallenges() {
        assertNull(StreamControllerProbe.response(probe() + ("controllerId" to "previous-process")))
        assertNull(StreamControllerProbe.response(probe() + ("protocolVersion" to 2)))
        assertNull(StreamControllerProbe.response(probe() + ("protocolVersion" to true)))
        assertNull(StreamControllerProbe.response(probe() + ("probeId" to "")))
        assertNull(StreamControllerProbe.response(probe() - "streamId"))
    }
}
