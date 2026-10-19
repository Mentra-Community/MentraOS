package com.mentra.bluetoothsdk.sgcs

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.Bridge
import java.time.Duration
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [G1PairingTest.ShadowLc3Cpp::class], instrumentedPackages = ["com.mentra.lc3Lib"])
@LooperMode(LooperMode.Mode.PAUSED)
class MentraLiveGlassesReadyBurstTest {
    @Test fun `buffered phone_ready copies are one exchange with one init`() = withLive { live, inits ->
        // Two SOC-ready heartbeats while the glasses boot: one exchange, sent twice.
        receive(live, socReady())
        val readyId = pendingReadyId(live)
        receive(live, socReady())
        assertEquals(readyId, pendingReadyId(live))

        // The glasses answer every buffered copy; only the first followed a reset.
        repeat(7) { receive(live, glassesReady("booted", readyId)) }
        assertEquals(1, inits())
    }

    @Test fun `answers to a superseded exchange are ignored until the pending one arrives`() = withLive { live, inits ->
        receive(live, socReady())
        val readyId = pendingReadyId(live)

        receive(live, glassesReady("booted", "superseded"))
        assertEquals(0, inits())
        receive(live, glassesReady("booted", readyId))
        assertEquals(1, inits())
    }

    @Test fun `an answer from another glasses process is handled with no exchange pending`() = withLive { live, inits ->
        receive(live, socReady())
        val readyId = pendingReadyId(live)
        receive(live, glassesReady("booted", readyId))

        // A restarted process reset its transport for this copy, so it is not a repeat.
        receive(live, glassesReady("restarted", readyId))
        assertEquals(2, inits())
    }

    @Test fun `glasses without readyId keep initializing on every answer`() = withLive { live, inits ->
        receive(live, glassesReady("legacy", null))
        receive(live, glassesReady("legacy", null))
        assertEquals(2, inits())
    }

    /** Runs `body` on a fresh MentraLive, counting SOC inits (one version request each). */
    private fun withLive(body: (MentraLive, () -> Int) -> Unit) {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        val live = MentraLive()
        var inits = 0
        val sink = Bridge.addEventSink { type, event ->
            if (type == "log" && event["message"].toString().contains("Requesting version info from ASG client")) {
                inits++
            }
        }
        try {
            body(live) { inits }
        } finally {
            Bridge.removeEventSink(sink)
            live.destroy()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        }
    }

    private fun socReady() = JSONObject().put("C", "sr_hrt").put("B", JSONObject().put("ready", 1))

    private fun glassesReady(sid: String, readyId: String?) = JSONObject().apply {
        put("type", "glasses_ready")
        put("sid", sid)
        if (readyId != null) put("readyId", readyId)
    }

    private fun pendingReadyId(live: MentraLive): String {
        val readyId = MentraLive::class.java.getDeclaredField("pendingReadyId")
            .apply { isAccessible = true }
            .get(live) as String?
        assertNotNull("SOC ready should start a readiness exchange", readyId)
        return readyId!!
    }

    private fun receive(live: MentraLive, json: JSONObject) {
        MentraLive::class.java.getDeclaredMethod("processJsonMessage", JSONObject::class.java)
            .apply { isAccessible = true }
            .invoke(live, json)
    }
}
