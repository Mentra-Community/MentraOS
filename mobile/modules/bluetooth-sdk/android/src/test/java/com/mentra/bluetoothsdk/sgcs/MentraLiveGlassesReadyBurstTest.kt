package com.mentra.bluetoothsdk.sgcs

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.Bridge
import java.time.Duration
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject
import org.junit.Assert.assertEquals
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
    @Test fun `repeated glasses_ready burst runs one trailing init`() = withBootedLive { live, inits ->
        // Replies to the phone_ready messages the glasses buffered while booting, with a
        // stale not-ready heartbeat from the same dump in the middle of them.
        repeat(6) { reply ->
            if (reply == 2) receive(live, JSONObject().put("C", "sr_hrt").put("B", JSONObject().put("ready", 0)))
            receive(live, glassesReady("booted"))
        }
        assertEquals(1, inits())

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1500))
        assertEquals(2, inits())
    }

    @Test fun `coalesced init stands down when the BLE session ends`() = withBootedLive { live, inits ->
        receive(live, glassesReady("booted"))
        (get(live, "bleSessionGeneration") as AtomicLong).incrementAndGet()

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1500))
        assertEquals(1, inits())
    }

    @Test fun `a restarted glasses process initializes immediately`() = withBootedLive { live, inits ->
        receive(live, glassesReady("restarted"))
        assertEquals(2, inits())
    }

    /** Runs `body` on a MentraLive whose first glasses_ready (sid "booted") already ran the SOC init. */
    private fun withBootedLive(body: (MentraLive, () -> Int) -> Unit) {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        val live = MentraLive()
        var inits = 0
        val sink = Bridge.addEventSink { type, event ->
            if (type == "log" && event["message"].toString().contains("Requesting version info from ASG client")) {
                inits++
            }
        }
        try {
            receive(live, glassesReady("booted"))
            assertEquals(1, inits)
            body(live) { inits }
        } finally {
            Bridge.removeEventSink(sink)
            live.destroy()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        }
    }

    private fun glassesReady(sid: String) = JSONObject().put("type", "glasses_ready").put("sid", sid)

    private fun receive(live: MentraLive, json: JSONObject) {
        MentraLive::class.java.getDeclaredMethod("processJsonMessage", JSONObject::class.java)
            .apply { isAccessible = true }
            .invoke(live, json)
    }

    private fun get(live: MentraLive, name: String): Any? =
        MentraLive::class.java.getDeclaredField(name).apply { isAccessible = true }.get(live)
}
