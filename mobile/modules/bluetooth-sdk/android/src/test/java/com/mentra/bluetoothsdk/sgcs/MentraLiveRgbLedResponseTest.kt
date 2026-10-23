package com.mentra.bluetoothsdk.sgcs

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.Bridge
import java.time.Duration
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

/**
 * The glasses answer every RGB LED command with `rgb_led_control_response` echoing the command's
 * requestId. MentraLive must forward that reply so the pending SDK request settles instead of
 * timing out.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [G1PairingTest.ShadowLc3Cpp::class], instrumentedPackages = ["com.mentra.lc3Lib"])
@LooperMode(LooperMode.Mode.PAUSED)
class MentraLiveRgbLedResponseTest {
    @Test fun `success reply settles the request it echoes`() {
        val replies = forwardedReplies(
            JSONObject().put("type", "rgb_led_control_response").put("requestId", "led-1")
                .put("state", "success").put("success", true),
        )

        assertEquals(1, replies.size)
        assertEquals("led-1", replies[0]["requestId"])
        assertEquals("success", replies[0]["state"])
    }

    @Test fun `error reply carries the glasses error code`() {
        val replies = forwardedReplies(
            JSONObject().put("type", "rgb_led_control_response").put("requestId", "led-2")
                .put("state", "error").put("success", false)
                .put("errorCode", "device_not_supported").put("error", "RGB LED not supported"),
        )

        assertEquals(1, replies.size)
        assertEquals("error", replies[0]["state"])
        assertEquals("device_not_supported", replies[0]["errorCode"])
    }

    @Test fun `reply without a requestId is not forwarded`() {
        val replies = forwardedReplies(
            JSONObject().put("type", "rgb_led_control_response").put("state", "success"),
        )

        assertTrue(replies.isEmpty())
    }

    private fun forwardedReplies(reply: JSONObject): List<Map<String, Any?>> {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        val live = MentraLive()
        val replies = mutableListOf<Map<String, Any?>>()
        val sink = Bridge.addEventSink { type, body ->
            if (type == "rgb_led_control_response") replies.add(body.toMap())
        }
        try {
            MentraLive::class.java.getDeclaredMethod("processJsonMessage", JSONObject::class.java)
                .apply { isAccessible = true }
                .invoke(live, reply)
            shadowOf(Looper.getMainLooper()).idle()
        } finally {
            Bridge.removeEventSink(sink)
            live.destroy()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        }
        return replies
    }
}
