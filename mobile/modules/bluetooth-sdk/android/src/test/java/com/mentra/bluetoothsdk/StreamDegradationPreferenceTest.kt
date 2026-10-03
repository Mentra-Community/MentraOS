package com.mentra.bluetoothsdk

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class StreamDegradationPreferenceTest {
    @Test
    fun preferenceSurvivesRequestBridgeAndSerialization() {
        for (preference in listOf("MAINTAIN_FRAMERATE", "MAINTAIN_RESOLUTION", "BALANCED", "DISABLED")) {
            val request = StreamRequest.fromMap(mapOf(
                "streamUrl" to "https://example.com/whip",
                "video" to mapOf("fps" to 5, "degradationPreference" to preference),
            ))
            assertEquals(preference, request.video?.degradationPreference)
            val wireVideo = request.toMap()["video"] as Map<*, *>
            assertEquals(preference, wireVideo["degradationPreference"])
            assertEquals(5, wireVideo["frameRate"])
            assertEquals(preference, StreamVideoConfig(degradationPreference = preference).toMap()["degradationPreference"])
        }
    }

    @Test
    fun omissionPreservesGlassesDefault() {
        val request = StreamRequest.fromMap(mapOf(
            "streamUrl" to "https://example.com/whip",
            "video" to mapOf("fps" to 5),
        ))
        assertNull(request.video?.degradationPreference)
        assertFalse((request.toMap()["video"] as Map<*, *>).containsKey("degradationPreference"))
        assertFalse(StreamVideoConfig().toMap().containsKey("degradationPreference"))
    }

    @Test
    fun compactKeyIsAcceptedAndFullKeyWins() {
        val compact = StreamVideoConfig.fromMap(mapOf("dp" to "MAINTAIN_RESOLUTION"))!!
        assertEquals("MAINTAIN_RESOLUTION", compact.toMap()["degradationPreference"])
        val full = StreamVideoConfig.fromMap(mapOf(
            "degradationPreference" to "BALANCED", "dp" to "DISABLED",
        ))!!
        assertEquals("BALANCED", full.toMap()["degradationPreference"])
    }

    @Test
    fun statusBridgePreservesAppliedPreferenceAndLegacyOmission() {
        for (preference in listOf(null, "MAINTAIN_RESOLUTION")) {
            val video = mutableMapOf<String, Any>(
                "width" to 1920, "height" to 1080, "bitrate" to 2_500_000, "fps" to 5.0,
            )
            preference?.let { video["degradationPreference"] = it }
            val event = StreamStatusEvent(mapOf(
                "status" to "streaming",
                "resolvedConfig" to mapOf("transport" to "whip", "video" to video),
            ))
            assertEquals(preference, event.resolvedConfig?.video?.degradationPreference)
            val resolved = event.values["resolvedConfig"] as Map<*, *>
            assertEquals(video, resolved["video"])
        }
    }
}
