package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.BluetoothSdkException
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.utils.IncidentLogBleRelayNaming
import java.net.ServerSocket
import java.net.SocketException
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.shadows.ShadowLog
import org.robolectric.shadows.ShadowSystemClock

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [G1PairingTest.ShadowLc3Cpp::class], instrumentedPackages = ["com.mentra.lc3Lib"])
@LooperMode(LooperMode.Mode.PAUSED)
class MentraLiveIncidentDispatchTest {
    private val incident = "rep_01M4HBVT88DFSN8TYNZ1WTV4PB"
    private val collidingIncident = "rep_01M4HBVT88DZZZZZZZZZZZZZZZ"
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

    @Test fun `colliding report waits for the owner's Cloud confirmation and never receives its evidence`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "synthetic")
        withCloud { cloud ->
            val name = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'B')
            assertEquals(name, IncidentLogBleRelayNaming.bleFileBaseName(collidingIncident, 'B'))

            live.sendIncidentId(incident, cloud.base)
            expectCode("incident_relay_busy") { live.sendIncidentId(collidingIncident, cloud.base) }
            assertFalse(wire(live).contains(collidingIncident))
            assertEquals(incident, relayOwner(live, name))
            assertEquals(incident, relayOwner(live, IncidentLogBleRelayNaming.bleFileBaseName(incident, 'L')))

            receiveRelayFile(live, name, "owner-evidence")
            assertEquals("/api/client/reports/$incident/artifacts owner-evidence", cloud.requests.poll(5, TimeUnit.SECONDS))
            awaitMain { relayOwner(live, name) == null }
            val confirmation = wire(live).substringAfterLast("transfer_complete")
            assertTrue(confirmation.contains(name) && confirmation.contains("\"success\":true"))

            // The owner's logcat name is still in flight, so the colliding report is still refused.
            val logName = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'L')
            expectCode("incident_relay_busy") { live.sendIncidentId(collidingIncident, cloud.base) }
            receiveRelayFile(live, logName, "owner-logcat")
            assertEquals("/api/client/reports/$incident/artifacts owner-logcat", cloud.requests.poll(5, TimeUnit.SECONDS))
            awaitMain { relayOwner(live, logName) == null }

            live.sendIncidentId(collidingIncident, cloud.base)
            receiveRelayFile(live, name, "second-evidence")
            assertEquals(
                "/api/client/reports/$collidingIncident/artifacts second-evidence",
                cloud.requests.poll(5, TimeUnit.SECONDS),
            )
        }
    }

    @Test fun `stale callback of a finished owner cannot confirm the colliding report's file`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "synthetic")
        withCloud { cloud ->
            val name = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'B')
            val logName = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'L')
            live.sendIncidentId(incident, cloud.base)
            val staleRelay = (get(live, "bleIncidentLogRelays") as Map<*, *>)[name]!!
            receiveRelayFile(live, name, "owner")
            assertNotNull(cloud.requests.poll(5, TimeUnit.SECONDS))
            awaitMain { relayOwner(live, name) == null }
            receiveRelayFile(live, logName, "owner-logcat")
            assertNotNull(cloud.requests.poll(5, TimeUnit.SECONDS))
            awaitMain { relayOwner(live, logName) == null }

            live.sendIncidentId(collidingIncident, cloud.base)
            val confirmationsBefore = wire(live).split("transfer_complete").size

            // A late callback of the first report's request arrives while the colliding report owns the name.
            uploadWith(live, staleRelay, name, "late-owner-evidence")
            assertNotNull(cloud.requests.poll(5, TimeUnit.SECONDS))
            repeat(50) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10) }

            assertEquals(confirmationsBefore, wire(live).split("transfer_complete").size)
            assertEquals(collidingIncident, relayOwner(live, name))
        }
    }

    @Test fun `failed Cloud POST keeps the owner until its ownership expires`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "synthetic")
        withCloud { cloud ->
            cloud.status = 500
            val name = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'B')
            live.sendIncidentId(incident, cloud.base)
            receiveRelayFile(live, name, "owner-evidence")
            assertNotNull(cloud.requests.poll(5, TimeUnit.SECONDS))
            awaitMain { wire(live).contains("\"success\":false") }
            assertEquals(incident, relayOwner(live, name))
            expectCode("incident_relay_busy") { live.sendIncidentId(collidingIncident, cloud.base) }
            live.sendIncidentId(incident, cloud.base)

            ShadowSystemClock.advanceBy(Duration.ofMillis(MentraLive.INCIDENT_RELAY_OWNERSHIP_MS))
            live.sendIncidentId(collidingIncident, cloud.base)
            assertEquals(collidingIncident, relayOwner(live, name))
        }
    }

    @Test fun `dispatch failure of a refused report cannot release the owner's names`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "synthetic")
        live.sendIncidentId(incident, apiBase)
        set(live, "txCharacteristic", null)
        expectCode("glasses_not_connected") { live.sendIncidentId(collidingIncident, apiBase) }
        assertEquals(incident, relayOwner(live, IncidentLogBleRelayNaming.bleFileBaseName(incident, 'B')))
    }

    // A plain socket server: com.sun.net.httpserver is not on the Android unit-test classpath.
    private class FakeCloud(val server: ServerSocket) {
        @Volatile var status = 200
        val requests = LinkedBlockingQueue<String>()
        val base get() = "http://127.0.0.1:${server.localPort}"
    }

    private fun withCloud(body: (FakeCloud) -> Unit) {
        val server = ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))
        val cloud = FakeCloud(server)
        val acceptor = Thread {
            while (!server.isClosed) {
                try {
                    server.accept().use { socket ->
                        val input = socket.getInputStream().buffered()
                        fun line(): String {
                            val sb = StringBuilder()
                            while (true) {
                                val c = input.read()
                                if (c < 0 || c == '\n'.code) break
                                if (c != '\r'.code) sb.append(c.toChar())
                            }
                            return sb.toString()
                        }
                        val path = line().split(" ").getOrElse(1) { "" }.substringBefore('?')
                        var length = 0
                        while (true) {
                            val header = line()
                            if (header.isEmpty()) break
                            if (header.startsWith("content-length:", ignoreCase = true)) {
                                length = header.substringAfter(':').trim().toInt()
                            }
                        }
                        val received = String(input.readNBytes(length), StandardCharsets.UTF_8)
                        cloud.requests.add("$path $received")
                        socket.getOutputStream().write(
                            "HTTP/1.1 ${cloud.status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                                .toByteArray(StandardCharsets.US_ASCII))
                        socket.getOutputStream().flush()
                    }
                } catch (_: SocketException) {
                    // closed by the test
                }
            }
        }.apply { isDaemon = true; start() }
        try { body(cloud) } finally { server.close(); acceptor.join(2_000) }
    }

    private fun receiveRelayFile(live: MentraLive, name: String, payload: String) {
        uploadWith(live, (get(live, "bleIncidentLogRelays") as Map<*, *>)[name]!!, name, payload)
    }

    private fun uploadWith(live: MentraLive, relay: Any, name: String, payload: String) {
        MentraLive::class.java.declaredMethods.first { it.name == "uploadBleIncidentLogPayload" }
            .apply { isAccessible = true }
            .invoke(live, relay, name, payload.toByteArray(StandardCharsets.UTF_8))
    }

    private fun relayOwner(live: MentraLive, name: String): String? {
        val relay = (get(live, "bleIncidentLogRelays") as Map<*, *>)[name] ?: return null
        return relay.javaClass.getDeclaredField("incidentId").apply { isAccessible = true }.get(relay) as String
    }

    private fun awaitMain(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + 5_000
        while (!condition() && System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        assertTrue(condition())
    }

    // sendJson wraps each message as {"C":"<escaped json>"}; unescape so assertions read the message.
    private fun wire(live: MentraLive): String =
        queuedWrites(live).joinToString("") { String(it, StandardCharsets.UTF_8) }.replace("\\\"", "\"")

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
