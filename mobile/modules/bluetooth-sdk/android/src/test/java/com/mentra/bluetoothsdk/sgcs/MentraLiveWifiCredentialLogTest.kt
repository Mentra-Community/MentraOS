package com.mentra.bluetoothsdk.sgcs

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.Bridge
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.UUID
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowLog

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [G1PairingTest.ShadowLc3Cpp::class], instrumentedPackages = ["com.mentra.lc3Lib"])
@LooperMode(LooperMode.Mode.PAUSED)
class MentraLiveWifiCredentialLogTest {
    @Test fun `wifi credentials reach the BLE queue without being logged`() {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        val ssid = "synthetic-${UUID.randomUUID()}"
        val password = UUID.randomUUID().toString()
        val events = mutableListOf<String>()
        val sink = Bridge.addEventSink { type, body -> if (type == "log") events.add(body["message"].toString()) }
        val live = MentraLive()
        try {
            ShadowLog.clear()
            live.sendWifiCredentials(ssid, password)

            val logs = events + ShadowLog.getLogs().map { it.msg }
            assertFalse("password logged", logs.any { it.contains(password) })
            assertTrue(events.any { it.endsWith("LIVE: Sending data to glasses: <set_wifi_credentials with credentials omitted>") })
            // The glasses still receive the unchanged credentials.
            val wire = queuedWrites(live).joinToString("") { String(it, StandardCharsets.UTF_8) }
            assertTrue(wire.contains("set_wifi_credentials"))
            assertTrue(wire.contains(ssid))
            assertTrue(wire.contains(password))
        } finally {
            Bridge.removeEventSink(sink)
            live.destroy()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        }
    }

    private fun queuedWrites(live: MentraLive): List<ByteArray> {
        val queue = MentraLive::class.java.getDeclaredField("sendQueue").apply { isAccessible = true }.get(live)
        return (queue as Iterable<*>).map { write ->
            write!!.javaClass.getDeclaredField("data").apply { isAccessible = true }.get(write) as ByteArray
        }
    }
}
