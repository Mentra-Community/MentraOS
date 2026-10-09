package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.BluetoothSdkException
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceStore
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.UUID
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.*
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
class MentraLiveIncidentDispatchTest {
    private val incident = "rep_01M4HBVT88DFSN8TYNZ1WTV4PB"
    private val apiBase = "https://core.dev.us-west-2.mentraglass.com"

    @Test fun `missing native BLE link rejects even when cached status is connected`() = withLive { live ->
        DeviceStore.set("glasses", "connected", true)
        expectCode("glasses_not_connected") { live.sendIncidentId(incident, apiBase) }
        assertTrue(queuedWrites(live).isEmpty())
    }

    @Test fun `missing current token does not fall back to old stored credentials`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "")
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val prefs = context.getSharedPreferences("augmentos_auth_prefs", android.content.Context.MODE_PRIVATE)
        prefs.edit().putString("core_token", "stale-synthetic-token").commit()
        expectCode("core_token_unavailable") { live.sendIncidentId(incident, apiBase) }
        assertTrue(queuedWrites(live).isEmpty())
        prefs.edit().remove("core_token").commit()
    }

    @Test fun `current token is queued before upload and never logged`() = withLive { live ->
        ready(live)
        val token = "synthetic-${UUID.randomUUID()}"
        DeviceStore.set("bluetooth", "core_token", token)
        ShadowLog.clear()
        live.sendIncidentId(incident, apiBase)
        val writes = queuedWrites(live)
        val wire = writes.joinToString("") { String(it, StandardCharsets.UTF_8) }
        assertEquals(2, writes.size)
        assertTrue(wire.indexOf("auth_token") < wire.indexOf("upload_incident_logs"))
        assertTrue(wire.contains(token))
        assertTrue(wire.contains(incident))
        assertFalse("token logged", ShadowLog.getLogs().any { it.msg.contains(token) })
    }

    @Test fun `link losing TX characteristic rejects instead of retaining incident relay`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "synthetic")
        set(live, "txCharacteristic", null)
        expectCode("glasses_not_connected") { live.sendIncidentId(incident, apiBase) }
        assertTrue(queuedWrites(live).isEmpty())
        val relays = get(live, "bleIncidentLogRelays") as Map<*, *>
        assertTrue(relays.isEmpty())
    }

    @Test fun `session loss during token serialization cannot queue an upload into the next session`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "synthetic-token")
        val generation = get(live, "bleSessionGeneration") as AtomicLong
        val sink = Bridge.addEventSink { type, body ->
            if (type == "log" && body["message"].toString().contains("<auth_token with credentials omitted>")) {
                generation.incrementAndGet()
            }
        }
        try {
            expectCode("incident_dispatch_failed") { live.sendIncidentId(incident, apiBase) }
            val wire = queuedWrites(live).joinToString("") { String(it, StandardCharsets.UTF_8) }
            assertFalse(wire.contains("upload_incident_logs"))
            assertTrue((get(live, "bleIncidentLogRelays") as Map<*, *>).isEmpty())
        } finally { Bridge.removeEventSink(sink) }
    }

    private fun ready(live: MentraLive) {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val gatt = BluetoothAdapter.getDefaultAdapter().getRemoteDevice("AA:BB:CC:DD:EE:FF")
            .connectGatt(context, false, object : BluetoothGattCallback() {})
        set(live, "isConnected", true)
        set(live, "bluetoothGatt", gatt)
        set(live, "txCharacteristic", BluetoothGattCharacteristic(UUID.randomUUID(), 0, 0))
    }

    private fun withLive(body: (MentraLive) -> Unit) {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        val live = MentraLive()
        val token = DeviceStore.get("bluetooth", "core_token")
        val connected = DeviceStore.get("glasses", "connected")
        try { body(live) } finally {
            DeviceStore.set("bluetooth", "core_token", token ?: "")
            DeviceStore.set("glasses", "connected", connected ?: false)
            live.destroy()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        }
    }

    private fun expectCode(code: String, body: () -> Unit) {
        try { body(); fail("Expected $code") } catch (error: BluetoothSdkException) { assertEquals(code, error.code) }
    }

    private fun get(live: MentraLive, name: String): Any? =
        MentraLive::class.java.getDeclaredField(name).apply { isAccessible = true }.get(live)

    private fun set(live: MentraLive, name: String, value: Any?) {
        MentraLive::class.java.getDeclaredField(name).apply { isAccessible = true }.set(live, value)
    }

    private fun queuedWrites(live: MentraLive): List<ByteArray> = (get(live, "sendQueue") as Iterable<*>).map { write ->
        write!!.javaClass.getDeclaredField("data").apply { isAccessible = true }.get(write) as ByteArray
    }
}
