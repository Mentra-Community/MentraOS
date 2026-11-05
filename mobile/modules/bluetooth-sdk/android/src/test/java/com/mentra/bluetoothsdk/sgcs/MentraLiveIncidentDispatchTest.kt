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
import java.io.File
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

    @Test fun `no Core URL rejects instead of sending logs anywhere else`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "synthetic")
        expectCode("core_url_unavailable") { live.sendIncidentId(incident, null) }
        expectCode("core_url_unavailable") { live.sendIncidentId(incident, "  ") }
        assertTrue(queuedWrites(live).isEmpty())
        assertTrue((get(live, "bleIncidentLogRelays") as Map<*, *>).isEmpty())
    }

    @Test fun `deletes the Core token older builds left in plain storage`() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val prefs = context.getSharedPreferences("augmentos_auth_prefs", android.content.Context.MODE_PRIVATE)
        prefs.edit().putString("core_token", "stale-synthetic-token").commit()
        withLive { }
        assertFalse(prefs.contains("core_token"))
    }

    @Test fun `the Core URL stays on the phone`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "synthetic")
        live.sendIncidentId(incident, apiBase)
        assertTrue(wire(live).contains("upload_incident_logs"))
        assertFalse(wire(live).contains("apiBaseUrl"))
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
            awaitMain { wire(live).contains("\"success\":true") }
            assertNull(cloud.requests.poll(200, TimeUnit.MILLISECONDS))
            assertEquals(incident, relayOwner(live, name))
            val confirmation = wire(live).substringAfterLast("transfer_complete")
            assertTrue(confirmation.contains(name) && confirmation.contains("\"success\":true"))

            // The BES bytes are held and the logcat name is still in flight, so the colliding
            // report is still refused.
            val logName = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'L')
            expectCode("incident_relay_busy") { live.sendIncidentId(collidingIncident, cloud.base) }
            receiveRelayFile(live, logName, "owner-logcat")
            assertEquals("/api/client/reports/$incident/artifacts owner-logcat", nextUpload(cloud))
            assertEquals("/api/client/reports/$incident/artifacts owner-evidence", nextUpload(cloud))
            awaitMain { relayOwner(live, logName) == null && relayOwner(live, name) == null }

            live.sendIncidentId(collidingIncident, cloud.base)
            receiveRelayFile(live, name, "second-evidence")
            awaitMain { wire(live).substringAfterLast("transfer_complete").contains("\"success\":true") }
            assertNull(cloud.requests.poll(200, TimeUnit.MILLISECONDS))
            receiveRelayFile(live, logName, "second-logcat")
            assertEquals(
                "/api/client/reports/$collidingIncident/artifacts second-logcat",
                nextUpload(cloud),
            )
            assertEquals(
                "/api/client/reports/$collidingIncident/artifacts second-evidence",
                nextUpload(cloud),
            )
        }
    }

    @Test fun `saves the bes log and uploads the mtk log before it`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "synthetic")
        withCloud { cloud ->
            val name = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'B')
            val logName = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'L')
            live.sendIncidentId(incident, cloud.base)
            val bes = """{"retryKey":"bes-crash","entries":[{"source":"BES"}]}"""
            receiveRelayFile(live, name, bes)
            awaitMain { wire(live).contains("\"success\":true") }
            assertNull(cloud.requests.poll(200, TimeUnit.MILLISECONDS))
            assertEquals(incident, relayOwner(live, name))

            receiveRelayFile(live, logName, """{"entries":[{"source":"MTK"}]}""")
            assertEquals(
                """/api/client/reports/$incident/artifacts {"entries":[{"source":"MTK"}]}""",
                nextUpload(cloud),
            )
            assertEquals(
                "/api/client/reports/$incident/artifacts $bes",
                nextUpload(cloud),
            )
            awaitMain { relayOwner(live, name) == null && relayOwner(live, logName) == null }
        }
    }

    @Test fun `a held BES log is durably persisted and re-uploaded after process death`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "synthetic")
        withCloud { cloud ->
            val name = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'B')
            live.sendIncidentId(incident, cloud.base)
            val bes = """{"source":"BES"}"""
            receiveRelayFile(live, name, bes)
            awaitMain { wire(live).contains("\"success\":true") }
            // Acknowledged to the glasses but not uploaded yet: the bytes must already be on disk.
            assertNull(cloud.requests.poll(200, TimeUnit.MILLISECONDS))
            assertTrue(besHeldFile(incident).exists())

            // Process death before the MTK log arrives: a fresh instance owns no relay and the
            // glasses will not resend, so it must finish the upload from the durable copy.
            val revived = MentraLive()
            try {
                invokeResume(revived)
                assertEquals("/api/client/reports/$incident/artifacts $bes", nextUpload(cloud))
                awaitMain { !besHeldFile(incident).exists() }
            } finally {
                revived.destroy()
            }
        }
    }

    @Test fun `a BES upload that fails during an outage is retried until Cloud confirms it`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "synthetic")
        withCloud { cloud ->
            cloud.status = 500
            val name = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'B')
            live.sendIncidentId(incident, cloud.base)
            val bes = """{"source":"BES"}"""
            receiveRelayFile(live, name, bes)
            awaitMain { wire(live).contains("\"success\":true") }

            // No MTK log arrives, so after the hold the phone uploads the BES itself; both
            // attempts fail against the outage.
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(31_000))
            awaitMain { cloud.requests.isNotEmpty() }
            var attempts = 0
            while (cloud.requests.poll(300, TimeUnit.MILLISECONDS) != null) attempts++
            assertTrue("expected at least one failed BES attempt", attempts >= 1)
            // The acknowledged artifact is retained, not stranded: still owned and still on disk.
            assertEquals(incident, relayOwner(live, name))
            assertTrue(besHeldFile(incident).exists())

            // Connectivity returns and the scheduled retry confirms the upload.
            cloud.status = 200
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(61_000))
            assertEquals("/api/client/reports/$incident/artifacts $bes", nextUpload(cloud))
            awaitMain { relayOwner(live, name) == null && !besHeldFile(incident).exists() }
        }
    }

    @Test fun `a saved BES log waits for its own account and Core`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", jwt("https://core-a", "user-a"))
        withCloud { cloud ->
            val name = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'B')
            live.sendIncidentId(incident, cloud.base)
            val bes = """{"source":"BES"}"""
            receiveRelayFile(live, name, bes)
            awaitMain { wire(live).contains("\"success\":true") }
            endProcess(live)

            val revived = MentraLive()
            try {
                for (other in listOf(jwt("https://core-b", "user-a"), jwt("https://core-a", "user-b"))) {
                    DeviceStore.set("bluetooth", "core_token", other)
                    invokeResume(revived)
                    shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(61_000))
                    assertNull(cloud.requests.poll(300, TimeUnit.MILLISECONDS))
                }
                assertTrue(besHeldFile(incident).exists())

                DeviceStore.set("bluetooth", "core_token", jwt("https://core-a", "user-a"))
                shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(61_000))
                assertEquals("/api/client/reports/$incident/artifacts $bes", nextUpload(cloud))
                awaitMain { !besHeldFile(incident).exists() }
            } finally {
                revived.destroy()
            }
        }
    }

    private fun jwt(iss: String, sub: String): String {
        val claims = """{"iss":"$iss","sub":"$sub"}""".toByteArray(StandardCharsets.UTF_8)
        return "h." + java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(claims) + ".s"
    }

    @Test fun `an MTK transfer cut off partway stops holding the BES log`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "synthetic")
        withCloud { cloud ->
            val besName = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'B')
            val mtkName = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'L')
            live.sendIncidentId(incident, cloud.base)
            val bes = """{"source":"BES"}"""
            receiveRelayFile(live, besName, bes)
            awaitMain { wire(live).contains("\"success\":true") }
            // Part of the MTK file arrived, then the link dropped: nothing will ever finish it.
            val mtkRelay = (get(live, "bleIncidentLogRelays") as Map<*, *>)[mtkName]!!
            mtkRelay.javaClass.getDeclaredField("session").apply { isAccessible = true }
                .set(mtkRelay, MentraLive.FileTransferSession(mtkName, 100_000))

            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(31_000))
            assertNull(cloud.requests.poll(300, TimeUnit.MILLISECONDS))

            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(121_000))
            assertEquals("/api/client/reports/$incident/artifacts $bes", nextUpload(cloud))
            awaitMain { !besHeldFile(incident).exists() }
        }
    }

    @Test fun `a BES log that cannot be saved is refused so the glasses keep their copy`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "synthetic")
        withCloud { cloud ->
            // A file where the directory belongs makes every save fail.
            besHeldDir().deleteRecursively()
            besHeldDir().writeText("not a directory")
            val name = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'B')
            live.sendIncidentId(incident, cloud.base)
            receiveRelayFile(live, name, """{"source":"BES"}""")
            awaitMain { wire(live).contains("\"success\":false") }
            assertFalse(wire(live).contains("\"success\":true"))
            assertEquals(incident, relayOwner(live, name))
            besHeldDir().delete()
        }
    }

    @Test fun `a BES log Cloud permanently refuses is dropped instead of retried forever`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "synthetic")
        withCloud { cloud ->
            cloud.status = 404
            val name = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'B')
            live.sendIncidentId(incident, cloud.base)
            receiveRelayFile(live, name, """{"source":"BES"}""")
            awaitMain { wire(live).contains("\"success\":true") }
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(31_000))
            awaitMain { relayOwner(live, name) == null && !besHeldFile(incident).exists() }
            assertNotNull(cloud.requests.poll(200, TimeUnit.MILLISECONDS))
            assertNull(cloud.requests.poll(200, TimeUnit.MILLISECONDS))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(61_000))
            assertNull(cloud.requests.poll(300, TimeUnit.MILLISECONDS))
        }
    }

    @Test fun `reconnecting during an outage does not start a second resume of a saved BES log`() = withLive { live ->
        ready(live)
        DeviceStore.set("bluetooth", "core_token", "synthetic")
        withCloud { cloud ->
            cloud.status = 500
            val name = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'B')
            live.sendIncidentId(incident, cloud.base)
            receiveRelayFile(live, name, """{"source":"BES"}""")
            awaitMain { wire(live).contains("\"success\":true") }
            endProcess(live)

            val revived = MentraLive()
            try {
                invokeResume(revived)
                awaitMain { cloud.requests.isNotEmpty() }
                while (cloud.requests.poll(300, TimeUnit.MILLISECONDS) != null) {}
                invokeResume(revived)
                invokeResume(revived)
                shadowOf(Looper.getMainLooper()).idle()
                assertNull(cloud.requests.poll(300, TimeUnit.MILLISECONDS))

                cloud.status = 200
                shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(61_000))
                awaitMain { !besHeldFile(incident).exists() }
                assertNotNull(cloud.requests.poll(300, TimeUnit.MILLISECONDS))
                assertNull(cloud.requests.poll(300, TimeUnit.MILLISECONDS))
            } finally {
                revived.destroy()
            }
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
            awaitMain { wire(live).contains("\"success\":true") }
            receiveRelayFile(live, logName, "owner-logcat")
            assertNotNull(nextUpload(cloud))
            assertNotNull(nextUpload(cloud))
            awaitMain { relayOwner(live, name) == null && relayOwner(live, logName) == null }

            live.sendIncidentId(collidingIncident, cloud.base)
            val confirmationsBefore = wire(live).split("transfer_complete").size

            // A late callback of the first report's file arrives while the colliding report owns the name.
            uploadWith(live, staleRelay, name, "late-owner-evidence")
            assertNull(cloud.requests.poll(400, TimeUnit.MILLISECONDS))
            repeat(20) { shadowOf(Looper.getMainLooper()).idle(); Thread.sleep(10) }

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
            val logName = IncidentLogBleRelayNaming.bleFileBaseName(incident, 'L')
            live.sendIncidentId(incident, cloud.base)
            receiveRelayFile(live, name, "owner-evidence")
            awaitMain { wire(live).contains("\"success\":true") }
            assertNull(cloud.requests.poll(200, TimeUnit.MILLISECONDS))
            receiveRelayFile(live, logName, "owner-logcat")
            assertEquals("/api/client/reports/$incident/artifacts owner-logcat", nextUpload(cloud))
            assertNull(cloud.requests.poll(200, TimeUnit.MILLISECONDS))
            awaitMain { wire(live).contains("\"success\":false") }
            assertEquals(incident, relayOwner(live, name))
            assertEquals(incident, relayOwner(live, logName))
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
        // The relay posts its save-or-upload onto the paused main looper.
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun nextUpload(cloud: FakeCloud): String {
        val deadline = System.currentTimeMillis() + 5_000
        while (cloud.requests.isEmpty() && System.currentTimeMillis() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        val request = cloud.requests.poll(200, TimeUnit.MILLISECONDS)
        assertNotNull(request)
        return request!!
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
            // destroy() deliberately keeps the durable held-BES copies on disk; clear the shared
            // external dir so one test's unfinished upload cannot leak into the next.
            besHeldDir().deleteRecursively()
        }
    }

    private fun besHeldDir(): File {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        return File(context.getExternalFilesDir(null), "MentraLive_HeldBes")
    }

    private fun besHeldFile(incidentId: String): File = File(besHeldDir(), "$incidentId.json")

    // The process died: the in-memory hold and its timers are gone, and the saved file remains.
    private fun endProcess(live: MentraLive) {
        MentraLive::class.java.getDeclaredMethod("clearHeldBesLogs")
            .apply { isAccessible = true }.invoke(live)
    }

    private fun invokeResume(live: MentraLive) {
        MentraLive::class.java.getDeclaredMethod("resumePersistedBesUploads")
            .apply { isAccessible = true }.invoke(live)
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
