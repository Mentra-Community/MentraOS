package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothProfile
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.debug.BleEvidenceLog
import com.mentra.bluetoothsdk.utils.K900ProtocolUtils
import com.mentra.bluetoothsdk.utils.MessageChunker
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.LooperMode
import org.robolectric.shadow.api.Shadow
import org.robolectric.shadows.ShadowBluetoothGatt

/**
 * Drives the production MentraLive GATT callback, decoder, send queue and Bridge with a fake
 * GATT transport (Robolectric shadows) and checks the provenance the evidence log records.
 */
@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [33],
    shadows = [G1PairingTest.ShadowLc3Cpp::class, MentraLiveEvidenceTest.FakeGattWrites::class],
    instrumentedPackages = ["com.mentra.lc3Lib"],
)
@LooperMode(LooperMode.Mode.PAUSED)
class MentraLiveEvidenceTest {
    /** Fake GATT write acceptance at the Android API boundary. */
    @Implements(BluetoothGatt::class)
    class FakeGattWrites : ShadowBluetoothGatt() {
        companion object {
            @JvmStatic var accept = false
            @JvmStatic val written = mutableListOf<String>()
        }

        @Suppress("DEPRECATION")
        @Implementation
        protected fun writeCharacteristic(characteristic: BluetoothGattCharacteristic): Boolean {
            if (accept) written.add(String(characteristic.value, StandardCharsets.ISO_8859_1))
            return accept
        }
    }

    private val serviceUuid = UUID.fromString("00004860-0000-1000-8000-00805f9b34fb")
    private val rxUuid = UUID.fromString("000070FF-0000-1000-8000-00805f9b34fb")
    private val txUuid = UUID.fromString("000071FF-0000-1000-8000-00805f9b34fb")
    private val peerA = "AA:BB:CC:DD:EE:01"
    private val peerB = "AA:BB:CC:DD:EE:02"
    private val events = mutableListOf<Pair<String, Map<String, Any>>>()
    private lateinit var sinkId: String
    private val managers = mutableListOf<MentraLive>()

    @Before fun setup() {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        shadowOf(BluetoothAdapter.getDefaultAdapter()).setState(BluetoothAdapter.STATE_ON)
        BleEvidenceLog.resetForTest()
        FakeGattWrites.accept = false
        FakeGattWrites.written.clear()
        sinkId = Bridge.addEventSink { type, body -> events.add(type to HashMap(body)) }
    }

    @After fun teardown() {
        Bridge.removeEventSink(sinkId)
        managers.forEach { it.destroy() }
        // Robolectric does not deliver the disconnect callback; finish the production timeout.
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(3))
    }

    // ---- helpers -------------------------------------------------------------------------

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private fun idleFor(ms: Long) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    private fun manager() = MentraLive().also { managers.add(it) }

    /** The send rate limiter reads wall-clock time, which Robolectric does not advance. */
    private fun drainSends() {
        Thread.sleep(250)
        idleFor(1_000)
    }

    private fun callback(gatt: BluetoothGatt) = Shadow.extract<ShadowBluetoothGatt>(gatt).gattCallback

    /** Connects [live] to [address] through connectById and the production GATT callback. */
    private fun connect(live: MentraLive, address: String): BluetoothGatt {
        val name = "MENTRA_LIVE_" + address.takeLast(2)
        val device = BluetoothAdapter.getDefaultAdapter().getRemoteDevice(address)
        shadowOf(device).setName(name)
        DeviceStore.set("bluetooth", "pending_device_name", name)
        DeviceStore.set("bluetooth", "device_name", name)
        DeviceStore.set("bluetooth", "pending_device_address", "")
        DeviceStore.set("bluetooth", "device_address", address)
        val before = shadowOf(device).bluetoothGatts.size
        live.connectById(name)
        idle()
        // A replaced connection waits for its teardown (timeout without a Robolectric callback).
        if (shadowOf(device).bluetoothGatts.size == before) idleFor(3_000)
        val gatts = shadowOf(device).bluetoothGatts
        assertEquals(before + 1, gatts.size)
        val gatt = gatts.last()
        val service = BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(BluetoothGattCharacteristic(rxUuid, BluetoothGattCharacteristic.PROPERTY_NOTIFY, 0))
        service.addCharacteristic(BluetoothGattCharacteristic(txUuid, BluetoothGattCharacteristic.PROPERTY_WRITE, 0))
        Shadow.extract<ShadowBluetoothGatt>(gatt).addDiscoverableService(service)
        callback(gatt).onConnectionStateChange(gatt, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED)
        idle()
        callback(gatt).onServicesDiscovered(gatt, BluetoothGatt.GATT_SUCCESS)
        idle()
        return gatt
    }

    private fun notifyRaw(gatt: BluetoothGatt, bytes: ByteArray) {
        callback(gatt).onCharacteristicChanged(gatt, BluetoothGattCharacteristic(rxUuid, 0, 0), bytes)
    }

    private fun notifyJson(gatt: BluetoothGatt, json: String) {
        notifyRaw(gatt, json.toByteArray(StandardCharsets.UTF_8))
        idle()
    }

    private fun notifyK900(gatt: BluetoothGatt, json: String) {
        notifyRaw(gatt, K900ProtocolUtils.packDataCommand(json.toByteArray(StandardCharsets.UTF_8), K900ProtocolUtils.CMD_TYPE_STRING))
        idle()
    }

    private fun records(target: String? = null): List<JSONObject> {
        val array = BleEvidenceLog.snapshot(0, target).getJSONArray("records")
        return (0 until array.length()).map { array.getJSONObject(it) }
    }

    private fun kind(kind: String, target: String? = null) = records(target).filter { it.getString("kind") == kind }

    private fun batteryEvents() = events.filter { it.first == "battery_status" }.map { it.second }

    private fun origin(record: JSONObject): Pair<Long, Long>? =
        if (record.isNull("origin")) null
        else record.getJSONObject("origin").let { it.getLong("connection") to it.getLong("wire") }

    // ---- receive provenance ----------------------------------------------------------------

    @Test
    fun `battery notification keeps its accepted origin through decoder and bridge`() {
        val live = manager()
        val gatt = connect(live, peerA)
        notifyJson(gatt, """{"type":"battery_status","percent":57}""")

        val event = batteryEvents().single()
        assertEquals(57, event["level"])
        val eventId = event["eventId"] as String
        val connection = kind("connection_accepted").single()
        assertEquals(peerA, connection.getString("peerMac"))
        val battery = kind("battery").single()
        assertEquals(BleEvidenceLog.eventId(battery.getLong("seq")), eventId)
        assertEquals(connection.getLong("seq") to connection.getLong("seq"), origin(battery))
        assertEquals("battery_status", battery.getString("source"))
        assertFalse("percent-only source never claims PMU charging", battery.has("pmuCharging"))
        val dispatch = kind("bridge_dispatch").single()
        assertEquals(eventId, dispatch.getString("eventId"))
        assertTrue(dispatch.getInt("sinks") > 0)
        assertTrue(dispatch.getLong("seq") > battery.getLong("seq"))
    }

    @Test
    fun `only the sr_hrt PMU bit is charging provenance`() {
        val gatt = connect(manager(), peerA)
        notifyK900(gatt, """{"C":"sr_hrt","B":{"pt":64,"ready":1,"charg":1}}""")
        notifyK900(gatt, """{"C":"sr_batv","B":{"vt":4010,"pt":63}}""")
        notifyJson(gatt, """{"type":"battery_status","percent":62}""")

        val batteries = kind("battery")
        assertEquals(listOf(64, 63, 62), batteries.map { it.getInt("percent") })
        assertEquals(listOf("k900_sr_hrt", "k900_sr_batv", "battery_status"), batteries.map { it.getString("source") })
        assertTrue(batteries[0].getBoolean("pmuCharging"))
        // The app still shows the inherited charging state, but it is not PMU evidence.
        assertEquals(listOf(true, true, true), batteryEvents().map { it["charging"] })
        assertFalse(batteries[1].has("pmuCharging"))
        assertFalse(batteries[2].has("pmuCharging"))
    }

    @Test
    fun `an unchanged percentage is two events with the same value, not a change`() {
        val gatt = connect(manager(), peerA)
        notifyJson(gatt, """{"type":"battery_status","percent":57}""")
        notifyJson(gatt, """{"type":"battery_status","percent":57}""")

        val batteries = kind("battery")
        assertEquals(listOf(57, 57), batteries.map { it.getInt("percent") })
        assertNotEquals(batteryEvents()[0]["eventId"], batteryEvents()[1]["eventId"])
    }

    @Test
    fun `queued notification bytes are copied before the owner decodes them`() {
        val gatt = connect(manager(), peerA)
        val bytes = """{"type":"battery_status","percent":41}""".toByteArray(StandardCharsets.UTF_8)
        notifyRaw(gatt, bytes)
        bytes[bytes.indexOf('4'.code.toByte())] = '9'.code.toByte()
        idle()
        assertEquals(listOf(41), kind("battery").map { it.getInt("percent") })
    }

    // ---- connection identity -----------------------------------------------------------------

    @Test
    fun `wrong peer and same-peer reconnect get distinct connection identities`() {
        // Switching glasses disconnects (destroys) the manager and creates another.
        for ((peer, percent) in listOf(peerA to 50, peerB to 51, peerA to 52)) {
            managers.lastOrNull()?.disconnect()
            idleFor(3_000)
            notifyJson(connect(manager(), peer), """{"type":"battery_status","percent":$percent}""")
        }

        val connections = kind("connection_accepted")
        assertEquals(listOf(peerA, peerB, peerA), connections.map { it.getString("peerMac") })
        assertEquals(3, connections.map { it.getLong("seq") }.distinct().size)
        // Each value is bound to the connection that received it, never the later current peer.
        assertEquals(connections.map { it.getLong("seq") }, kind("battery").map { origin(it)!!.first })
        assertEquals(listOf("teardown", "teardown"), kind("connection_closed").map { it.getString("reason") })
        val current = BleEvidenceLog.snapshot(0, null).getJSONObject("current")
        assertEquals(peerA, current.getString("peerMac"))
        assertEquals(connections.last().getLong("seq"), current.getLong("connection"))
    }

    @Test
    fun `remote disconnect closes the identity and later callbacks from that GATT are rejected`() {
        val gatt = connect(manager(), peerA)
        callback(gatt).onConnectionStateChange(gatt, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_DISCONNECTED)
        idle()
        notifyJson(gatt, """{"type":"battery_status","percent":33}""")

        assertTrue(kind("connection_closed").any { it.getString("reason") == "remote_disconnect" })
        assertTrue(kind("battery").isEmpty())
        assertEquals("stale_gatt", kind("receive_rejected").last().getString("reason"))
        assertTrue(BleEvidenceLog.snapshot(0, null).getJSONObject("current").isNull("connection"))

        // High-rate audio from the dead link is not evidence and must not flood the bounded log.
        val before = kind("receive_rejected").size
        val lc3 = BluetoothGattCharacteristic(UUID.fromString("6E400002-B5A3-F393-E0A9-E50E24DCCA9E"), 0, 0)
        repeat(20) { callback(gatt).onCharacteristicChanged(gatt, lc3, byteArrayOf(0xA0.toByte(), 1, 2)) }
        idle()
        assertEquals(before, kind("receive_rejected").size)
    }

    @Test
    fun `manager recreation in one process never reuses a connection identity`() {
        val first = manager()
        val oldGatt = connect(first, peerA)
        notifyJson(oldGatt, """{"type":"battery_status","percent":70}""")
        first.destroy()
        idleFor(3_000)
        val second = manager()
        notifyJson(connect(second, peerA), """{"type":"battery_status","percent":71}""")
        // A late callback for the destroyed manager's GATT cannot produce a value.
        notifyJson(oldGatt, """{"type":"battery_status","percent":99}""")

        val connections = kind("connection_accepted").map { it.getLong("seq") }
        assertEquals(2, connections.distinct().size)
        assertEquals(listOf(70, 71), kind("battery").map { it.getInt("percent") })
        assertEquals(connections, kind("battery").map { origin(it)!!.first })
        assertEquals("stale_gatt", kind("receive_rejected").last().getString("reason"))
    }

    @Test
    fun `a notification queued behind teardown is rejected explicitly`() {
        val live = manager()
        val gatt = connect(live, peerA)
        live.disconnect()
        idle()
        notifyJson(gatt, """{"type":"battery_status","percent":12}""")

        assertTrue(kind("battery").isEmpty())
        assertTrue(batteryEvents().isEmpty())
        assertEquals("teardown", kind("receive_rejected").last().getString("reason"))
    }

    @Test
    fun `wire reset without disconnect starts a new wire epoch and drops straddling chunks`() {
        val gatt = connect(manager(), peerA)
        val padded = """{"type":"battery_status","percent":44,"pad":"${"x".repeat(400)}"}"""
        val chunks = MessageChunker.createChunks(padded, 0L)
        assertTrue(chunks.size > 1)
        notifyJson(gatt, chunks[0].toString())
        notifyJson(gatt, """{"type":"glasses_ready"}""")
        chunks.drop(1).forEach { notifyJson(gatt, it.toString()) }
        assertTrue("a message straddling the reset must not be decoded", kind("battery").isEmpty())

        notifyJson(gatt, """{"type":"battery_status","percent":45}""")
        val connection = kind("connection_accepted").single().getLong("seq")
        val wireReset = kind("wire_reset").single()
        assertEquals(connection, wireReset.getLong("connection"))
        assertEquals(connection to wireReset.getLong("seq"), origin(kind("battery").single()))
    }

    // ---- Wi-Fi scan send and chunks -------------------------------------------------------

    @Test
    fun `scan command counts as sent only after GATT accepts and acknowledges the write`() {
        FakeGattWrites.accept = true
        val gatt = connect(manager(), peerA)
        live(gatt).requestWifiScan("scan-accepted")
        drainSends()
        val tx = BluetoothGattCharacteristic(txUuid, BluetoothGattCharacteristic.PROPERTY_WRITE, 0)
        callback(gatt).onCharacteristicWrite(gatt, tx, BluetoothGatt.GATT_SUCCESS)
        idle()

        val sends = kind("scan_send").filter { it.getString("scanId") == "scan-accepted" }
        assertEquals(listOf("queued", "gatt_accepted", "write_ok"), sends.map { it.getString("outcome") })
        assertEquals(kind("connection_accepted").single().getLong("seq"), sends.last().getLong("connection"))
        assertTrue(FakeGattWrites.written.any { it.contains("scan-accepted") })
    }

    @Test
    fun `refused or failed scan writes never become an accepted send`() {
        val gatt = connect(manager(), peerA)
        live(gatt).requestWifiScan("scan-refused")
        drainSends()
        assertEquals(
            listOf("queued", "gatt_refused"),
            kind("scan_send").filter { it.getString("scanId") == "scan-refused" }.map { it.getString("outcome") },
        )

        FakeGattWrites.accept = true
        live(gatt).requestWifiScan("scan-failed")
        drainSends()
        callback(gatt).onCharacteristicWrite(
            gatt,
            BluetoothGattCharacteristic(txUuid, BluetoothGattCharacteristic.PROPERTY_WRITE, 0),
            133,
        )
        idle()
        assertEquals(
            listOf("queued", "gatt_accepted", "write_failed"),
            kind("scan_send").filter { it.getString("scanId") == "scan-failed" }.map { it.getString("outcome") },
        )
    }

    @Test
    fun `scan requested while disconnected is refused, not sent`() {
        FakeGattWrites.accept = true
        val live = manager()
        val gatt = connect(live, peerA)
        callback(gatt).onConnectionStateChange(gatt, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_DISCONNECTED)
        idle()
        live.requestWifiScan("scan-offline")
        drainSends()

        // Queued is intent only; it never reaches GATT without a connection.
        val outcomes = kind("scan_send").filter { it.getString("scanId") == "scan-offline" }.map { it.getString("outcome") }
        assertEquals(listOf("queued"), outcomes)
        assertFalse(FakeGattWrites.written.any { it.contains("scan-offline") })
    }

    @Test
    fun `scan chunks carry origin and expose only the protected target`() {
        val gatt = connect(manager(), peerA)
        val chunk = JSONObject()
            .put("type", "wifi_scan_result")
            .put("scanId", "scan-1")
            .put("scan_complete", true)
            .put(
                "networks_neo",
                JSONArray()
                    .put(JSONObject().put("ssid", "LabAP").put("requiresPassword", true))
                    .put(JSONObject().put("ssid", "Neighbor").put("requiresPassword", false)),
            )
        notifyJson(gatt, chunk.toString())

        val event = events.single { it.first == "wifi_scan_result" }.second
        val eventId = event["eventId"] as String
        val target = BleEvidenceLog.sha256Hex("LabAP")
        val record = kind("scan_chunk", target).single()
        assertEquals(BleEvidenceLog.eventId(record.getLong("seq")), eventId)
        assertEquals("scan-1", record.getString("scanId"))
        assertTrue(record.getBoolean("complete"))
        assertEquals(kind("connection_accepted").single().getLong("seq"), origin(record)!!.first)
        assertTrue(record.getBoolean("targetSeen"))
        assertTrue(record.getBoolean("targetRequiresPassword"))
        val serialized = BleEvidenceLog.snapshot(0, target).toString()
        assertFalse(serialized.contains("LabAP"))
        assertFalse(serialized.contains("Neighbor"))
    }

    @Test
    fun `a decoded scan with more networks than retained digests never certifies target absence`() {
        val gatt = connect(manager(), peerA)
        val networks = JSONArray()
        (1..70).forEach { networks.put(JSONObject().put("ssid", "Net$it").put("requiresPassword", it == 70)) }
        notifyJson(
            gatt,
            JSONObject().put("type", "wifi_scan_result").put("scanId", "scan-many").put("scan_complete", true)
                .put("networks_neo", networks).toString(),
        )

        // The normal consumer still receives every network unchanged.
        @Suppress("UNCHECKED_CAST")
        val delivered = events.single { it.first == "wifi_scan_result" }.second["networks"] as List<Map<String, Any>>
        assertEquals(70, delivered.size)
        assertEquals(true, delivered.last()["requiresPassword"])

        val beyond = kind("scan_chunk", BleEvidenceLog.sha256Hex("Net70")).single()
        assertTrue("target beyond retained digests must not be reported absent", beyond.isNull("targetSeen"))
        assertEquals("incomplete", beyond.getString("targetCoverage"))
        val covered = kind("scan_chunk", BleEvidenceLog.sha256Hex("Net1")).single()
        assertTrue(covered.getBoolean("targetSeen"))
        assertFalse(covered.getBoolean("targetRequiresPassword"))
    }

    @Test
    fun `a scan write queued before a send-queue reset keeps its generation and is never sent`() {
        FakeGattWrites.accept = true
        val live = manager()
        val gatt = connect(live, peerA)
        val tx = BluetoothGattCharacteristic(txUuid, BluetoothGattCharacteristic.PROPERTY_WRITE, 0)
        live.requestWifiScan("scan-first")
        drainSends()
        callback(gatt).onCharacteristicWrite(gatt, tx, BluetoothGatt.GATT_SUCCESS)
        // Without real time passing, the rate limiter keeps the next write queued.
        live.requestWifiScan("scan-pending")
        idle()
        callback(gatt).onConnectionStateChange(gatt, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_DISCONNECTED)
        idle()
        drainSends()

        val generations = kind("ble_generation")
        assertEquals(listOf(0L, 1L), generations.map { it.getLong("generation") })
        val before = generations[0].getLong("seq")
        val after = generations[1].getLong("seq")
        assertTrue(kind("connection_accepted").single().getLong("seq") > before)
        val first = kind("scan_send").filter { it.getString("scanId") == "scan-first" }
        assertEquals(listOf("queued", "gatt_accepted", "write_ok"), first.map { it.getString("outcome") })
        assertTrue(first.all { it.getLong("writeGeneration") == before })
        val pending = kind("scan_send").filter { it.getString("scanId") == "scan-pending" }
        assertEquals(listOf("queued"), pending.map { it.getString("outcome") })
        assertEquals(before, pending.single().getLong("writeGeneration"))
        assertTrue(after > pending.single().getLong("seq"))
        assertEquals(after, BleEvidenceLog.snapshot(0, null).getJSONObject("current").getLong("writeGeneration"))
        assertFalse(FakeGattWrites.written.any { it.contains("scan-pending") })
    }

    @Test
    fun `events without native provenance carry no id`() {
        // e.g. another glasses model or a synthesized status: nothing to adopt.
        Bridge.sendBatteryStatus(80, false)
        val event = batteryEvents().single()
        assertFalse(event.containsKey("eventId"))
        assertTrue(kind("bridge_dispatch").isEmpty())
        assertNotNull(event["level"])
    }

    private fun live(gatt: BluetoothGatt): MentraLive = managers.last()
}
