package com.mentra.bluetoothsdk.sgcs

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GlassesAudioSetupPolicyTest {
    @Test
    fun `android needs no user step on any model - not_applicable when ready, idle otherwise`() {
        assertEquals(GlassesAudioSetupState.NOT_APPLICABLE, GlassesAudioSetupPolicy.state(ready = true))
        assertEquals(GlassesAudioSetupState.IDLE, GlassesAudioSetupPolicy.state(ready = false))
    }

    @Test
    fun `states encode as the shared map shape`() {
        assertEquals(mapOf("state" to "idle"), GlassesAudioSetupState.IDLE.toMap())
        assertEquals(mapOf("state" to "not_applicable"), GlassesAudioSetupState.NOT_APPLICABLE.toMap())
        assertEquals(mapOf("state" to "connecting"), GlassesAudioSetupState.CONNECTING.toMap())
        assertEquals(mapOf("state" to "connected"), GlassesAudioSetupState.CONNECTED.toMap())
        assertEquals(
                mapOf("state" to "needs_user", "action" to "connect_in_settings"),
                GlassesAudioSetupState.NEEDS_USER.toMap(),
        )
    }

    @Test
    fun `every state round-trips and unknown values are rejected`() {
        for (state in GlassesAudioSetupState.values()) {
            assertEquals(state, GlassesAudioSetupState.fromMap(state.toMap()))
        }
        assertNull(GlassesAudioSetupState.fromMap(mapOf("state" to "paired")))
        assertNull(GlassesAudioSetupState.fromMap(mapOf("action" to "connect_in_settings")))
        assertNull(GlassesAudioSetupState.fromMap("not_applicable"))
        assertNull(GlassesAudioSetupState.fromMap(null))
    }

    @Test
    fun `audio_setup_changed fires only when readiness changes the state`() {
        assertEquals(GlassesAudioSetupState.NOT_APPLICABLE, GlassesAudioSetupPolicy.change(wasReady = false, ready = true))
        assertEquals(GlassesAudioSetupState.IDLE, GlassesAudioSetupPolicy.change(wasReady = true, ready = false))
        assertNull(GlassesAudioSetupPolicy.change(wasReady = true, ready = true))
        assertNull(GlassesAudioSetupPolicy.change(wasReady = false, ready = false))
    }

    @Test
    fun `classic_link reads both links and tolerates missing or odd fields`() {
        assertEquals(
                MentraLiveClassicLink(a2dp = true, hfp = false),
                MentraLiveClassicLink.parse(JSONObject("""{"type":"classic_link","a2dp":true,"hfp":false}""")),
        )
        assertEquals(
                MentraLiveClassicLink(a2dp = false, hfp = true),
                MentraLiveClassicLink.parse(JSONObject("""{"type":"classic_link","a2dp":false,"hfp":true}""")),
        )
        assertEquals(
                MentraLiveClassicLink(a2dp = false, hfp = false),
                MentraLiveClassicLink.parse(JSONObject("""{"type":"classic_link"}""")),
        )
        assertEquals(
                MentraLiveClassicLink(a2dp = false, hfp = false),
                MentraLiveClassicLink.parse(JSONObject("""{"type":"classic_link","a2dp":"up","hfp":null}""")),
        )
    }
}
