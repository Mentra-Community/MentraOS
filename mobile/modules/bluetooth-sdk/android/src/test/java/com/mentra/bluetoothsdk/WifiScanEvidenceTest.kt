package com.mentra.bluetoothsdk

import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.debug.BleEvidenceLog
import com.mentra.bluetoothsdk.sgcs.G1PairingTest
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Runs the production MentraBluetoothSdk.requestWifiScan and its Bridge chunk handling. Chunks
 * enter through Bridge.updateWifiScanResults, the same call MentraLive makes after decoding.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [G1PairingTest.ShadowLc3Cpp::class], instrumentedPackages = ["com.mentra.lc3Lib"])
class WifiScanEvidenceTest {
    private lateinit var sdk: MentraBluetoothSdk

    @Before fun setup() {
        BleEvidenceLog.resetForTest()
        sdk = MentraBluetoothSdk.create(ApplicationProvider.getApplicationContext(), object : MentraBluetoothSdkListener {})
    }

    @After fun close() = sdk.close()

    private fun records(kind: String): List<JSONObject> {
        val array = BleEvidenceLog.snapshot(0, null).getJSONArray("records")
        return (0 until array.length()).map { array.getJSONObject(it) }.filter { it.getString("kind") == kind }
    }

    private fun freshScanId() = records("scan_request").single { it.getString("mode") == "fresh" }.getString("scanId")

    private fun chunk(scanId: String?, ssid: String, complete: Boolean) =
        Bridge.updateWifiScanResults(
            listOf(mapOf("ssid" to ssid, "requiresPassword" to true, "signalStrength" to -40)),
            complete,
            scanId,
            BleEvidenceLog.scanChunk(null, scanId, emptyList(), complete, entriesParsed = true),
        )

    @Test
    fun `explicit completion of the fresh request is the only complete terminal`() = runBlocking {
        val scan = async(start = CoroutineStart.UNDISPATCHED) { sdk.requestWifiScan() }
        val scanId = freshScanId()
        chunk(scanId, "LabAP", complete = false)
        yield()
        assertFalse(scan.isCompleted)
        assertTrue("streamed chunks are not completion", records("scan_terminal").isEmpty())

        chunk(scanId, "Other", complete = true)
        assertEquals(listOf("LabAP", "Other"), scan.await().map { it.ssid })
        val terminal = records("scan_terminal").single()
        assertEquals(scanId, terminal.getString("scanId"))
        assertEquals("complete", terminal.getString("result"))
    }

    @Test
    fun `a joined caller is recorded as joining the older request, not a fresh scan`() = runBlocking {
        val first = async(start = CoroutineStart.UNDISPATCHED) { sdk.requestWifiScan() }
        val joined = async(start = CoroutineStart.UNDISPATCHED) { sdk.requestWifiScan() }
        val scanId = freshScanId()
        val requests = records("scan_request")
        assertEquals(listOf("fresh", "joined"), requests.map { it.getString("mode") })
        assertEquals(listOf(scanId, scanId), requests.map { it.getString("scanId") })

        chunk(scanId, "LabAP", complete = true)
        assertEquals(first.await(), joined.await())
    }

    @Test
    fun `a chunk for another scan id neither resolves nor completes the fresh request`() = runBlocking {
        val scan = async(start = CoroutineStart.UNDISPATCHED) { sdk.requestWifiScan() }
        val scanId = freshScanId()
        chunk("scan-older", "Stale", complete = true)
        yield()
        assertFalse(scan.isCompleted)
        assertTrue(records("scan_terminal").isEmpty())

        chunk(scanId, "LabAP", complete = true)
        assertEquals(listOf("LabAP"), scan.await().map { it.ssid })
    }

    @Test
    fun `legacy uncorrelated results are never a correlated completion`() = runBlocking {
        val scan = async(start = CoroutineStart.UNDISPATCHED) { sdk.requestWifiScan() }
        val scanId = freshScanId()
        chunk(null, "Legacy", complete = true)
        assertEquals(listOf("Legacy"), scan.await().map { it.ssid })
        val terminal = records("scan_terminal").single()
        assertEquals(scanId, terminal.getString("scanId"))
        assertEquals("legacy_uncorrelated", terminal.getString("result"))
    }

    @Test
    fun `a timeout that returns partial results is recorded as partial, not complete`() = runBlocking {
        val scan = async(start = CoroutineStart.UNDISPATCHED) { sdk.requestWifiScan() }
        val scanId = freshScanId()
        chunk(scanId, "LabAP", complete = false)
        // Customer behavior is unchanged: the promise still resolves with the partial list.
        assertEquals(listOf("LabAP"), scan.await().map { it.ssid })
        val terminal = records("scan_terminal").single()
        assertEquals(scanId, terminal.getString("scanId"))
        assertEquals("timeout_partial", terminal.getString("result"))
        assertEquals(1, terminal.getInt("networks"))
    }
}
