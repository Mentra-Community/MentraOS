package com.mentra.bluetoothsdk.debug

import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class BleEvidenceLogTest {
    @Before fun reset() = BleEvidenceLog.resetForTest()

    private fun records(snapshot: JSONObject) =
        snapshot.getJSONArray("records").let { array -> (0 until array.length()).map { array.getJSONObject(it) } }

    @Test
    fun `ids derive from one stream and a strict sequence`() {
        val origin = BleEvidenceLog.connectionAccepted("AA:BB:CC:DD:EE:01")
        val first = BleEvidenceLog.battery(origin, 57, "battery_status", null)
        val second = BleEvidenceLog.battery(origin, 57, "battery_status", null)

        assertEquals("${BleEvidenceLog.streamId}:2", first)
        assertEquals("${BleEvidenceLog.streamId}:3", second)
        val snapshot = BleEvidenceLog.snapshot(0, null)
        assertEquals("ok", snapshot.getString("outcome"))
        assertEquals(listOf(1L, 2L, 3L), records(snapshot).map { it.getLong("seq") })
        assertEquals(3L, snapshot.getLong("fenceSeq"))
        // Percent-only sources never claim PMU charging.
        assertFalse(records(snapshot)[1].has("pmuCharging"))
    }

    @Test
    fun `eviction is an explicit gap, never a clean interval`() {
        repeat(BleEvidenceLog.CAPACITY + 88) { BleEvidenceLog.receiveRejected("stale_gatt", null) }

        val gap = BleEvidenceLog.snapshot(0, null)
        assertEquals("gap", gap.getString("outcome"))
        assertEquals(88L, gap.getLong("droppedCount"))
        assertEquals(89L, gap.getLong("firstRetainedSeq"))
        assertEquals("ok", BleEvidenceLog.snapshot(88, null).getString("outcome"))
    }

    @Test
    fun `cursor from another process or the future is stale`() {
        BleEvidenceLog.connectionAccepted("AA:BB:CC:DD:EE:01")
        val oldStream = BleEvidenceLog.streamId
        BleEvidenceLog.resetForTest()

        val stale = BleEvidenceLog.snapshot(1, null)
        assertEquals("stale_cursor", stale.getString("outcome"))
        assertNotEquals(oldStream, stale.getString("streamId"))
        assertEquals(0, stale.getJSONArray("records").length())
    }

    @Test
    fun `malformed requests are refused`() {
        assertEquals("invalid_request", BleEvidenceLog.snapshot(null, null).getString("outcome"))
        assertEquals("invalid_request", BleEvidenceLog.snapshot(0, "LabAP").getString("outcome"))
    }

    @Test
    fun `scan snapshot reports only the requested target and never an SSID`() {
        val origin = BleEvidenceLog.connectionAccepted("AA:BB:CC:DD:EE:01")
        BleEvidenceLog.scanChunk(
            origin,
            "scan-1",
            listOf(
                mapOf("ssid" to "LabAP", "requiresPassword" to true),
                mapOf("ssid" to "Neighbor", "requiresPassword" to false),
                mapOf("ssid" to "Stringly", "requiresPassword" to "true"),
            ),
            complete = true,
        )

        val targeted = BleEvidenceLog.snapshot(0, BleEvidenceLog.sha256Hex("LabAP"))
        val chunk = records(targeted).single { it.getString("kind") == "scan_chunk" }
        assertTrue(chunk.getBoolean("targetSeen"))
        assertTrue(chunk.getBoolean("targetRequiresPassword"))
        assertEquals(3, chunk.getInt("networks"))
        assertFalse(targeted.toString().contains("LabAP"))
        assertFalse(targeted.toString().contains("Neighbor"))

        val absent = records(BleEvidenceLog.snapshot(0, BleEvidenceLog.sha256Hex("Other"))).last()
        assertFalse(absent.getBoolean("targetSeen"))
        assertFalse(absent.has("targetRequiresPassword"))

        // Only an exact boolean counts as the security value.
        val nonBoolean = records(BleEvidenceLog.snapshot(0, BleEvidenceLog.sha256Hex("Stringly"))).last()
        assertTrue(nonBoolean.getBoolean("targetSeen"))
        assertTrue(nonBoolean.isNull("targetRequiresPassword"))

        assertFalse(records(BleEvidenceLog.snapshot(0, null)).last().has("targetSeen"))
    }

    @Test
    fun `render markers accept only allowlisted surfaces, bounded values and ids of this stream`() {
        val id = BleEvidenceLog.battery(BleEvidenceLog.connectionAccepted("AA:BB:CC:DD:EE:01"), 57, "battery_status", null)

        assertFalse(BleEvidenceLog.uiRender("debug_panel", listOf(id), 1))
        assertFalse(BleEvidenceLog.uiRender(BleEvidenceLog.SURFACE_BATTERY, listOf(id), 101))
        assertTrue(
            BleEvidenceLog.uiRender(
                BleEvidenceLog.SURFACE_BATTERY,
                listOf(id, "other-stream:2", "${BleEvidenceLog.streamId}:999"),
                57,
            )
        )
        val render = records(BleEvidenceLog.snapshot(0, null)).last()
        assertEquals("ui_render", render.getString("kind"))
        assertEquals(listOf(id), (0 until render.getJSONArray("eventIds").length()).map { render.getJSONArray("eventIds").getString(it) })
        assertEquals(2, render.getInt("rejectedEventIds"))
        assertEquals(57, render.getInt("value"))
    }

    @Test
    fun `dump answers only its command and reports an unavailable owner`() {
        BleEvidenceLog.connectionAccepted("AA:BB:CC:DD:EE:01")
        val main = Handler(Looper.getMainLooper())

        assertNull(BleEvidenceLog.dump(arrayOf("--other"), main))
        assertNull(BleEvidenceLog.dump(null, main))

        val line = BleEvidenceLog.dump(arrayOf(BleEvidenceLog.DUMP_COMMAND, "afterSeq=0"), main)!!
        assertTrue(line.startsWith(BleEvidenceLog.OUTPUT_PREFIX))
        val json = JSONObject(line.removePrefix(BleEvidenceLog.OUTPUT_PREFIX))
        assertEquals("ok", json.getString("outcome"))
        assertEquals("AA:BB:CC:DD:EE:01", json.getJSONObject("current").getString("peerMac"))

        val unknownArg = BleEvidenceLog.dump(arrayOf(BleEvidenceLog.DUMP_COMMAND, "afterSeq=0", "eval=1"), main)!!
        assertEquals("invalid_request", JSONObject(unknownArg.removePrefix(BleEvidenceLog.OUTPUT_PREFIX)).getString("outcome"))

        val dead = HandlerThread("dead-owner").apply { start() }
        val deadHandler = Handler(dead.looper)
        dead.quitSafely()
        dead.join()
        val unavailable = BleEvidenceLog.dump(arrayOf(BleEvidenceLog.DUMP_COMMAND, "afterSeq=0"), deadHandler, 50)!!
        assertEquals("unavailable", JSONObject(unavailable.removePrefix(BleEvidenceLog.OUTPUT_PREFIX)).getString("outcome"))
    }
}
