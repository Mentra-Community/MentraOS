package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.GlassesStatus
import java.time.Duration
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

/**
 * Drives [MentraLive]'s real BLE message handling and the shared status layer: audioSetup in
 * the ready snapshot, the unknown-capability readiness wait, the selected-row secure rule, the
 * secure firmware refresh, and the `classic_link` message.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [G1PairingTest.ShadowLc3Cpp::class], instrumentedPackages = ["com.mentra.lc3Lib"])
@LooperMode(LooperMode.Mode.PAUSED)
class MentraLiveAudioSetupReadinessTest {
    private val targetName = "MENTRA_LIVE_BLE_AUDIOSETUP"
    private val targetAddress = "AA:BB:CC:DD:EE:42"

    @Test fun `readiness and audioSetup arrive in one snapshot and audio_setup_changed fires once`() =
            withLive(selectedCapability = false) { live, events ->
                val snapshots = CopyOnWriteArrayList<Map<String, Any>>()
                val listener =
                        DeviceStore.store.addListener { category, _ ->
                            if (category == "glasses") snapshots.add(glassesSnapshot())
                        }
                try {
                    message(live, """{"type":"glasses_ready"}""")
                } finally {
                    DeviceStore.store.removeListener(listener)
                }
                assertTrue(ready())
                val readySnapshots = snapshots.filter { it["connection"].let { c -> (c as Map<*, *>)["fullyBooted"] == true } }
                assertTrue(readySnapshots.isNotEmpty())
                // Never "ready" with a stale idle.
                readySnapshots.forEach { assertEquals(mapOf("state" to "not_applicable"), it["audioSetup"]) }
                assertEquals(listOf(mapOf("state" to "not_applicable")), audioSetupEvents(events))

                // A repeated ready report is not a change.
                message(live, """{"type":"glasses_ready"}""")
                assertEquals(1, audioSetupEvents(events).size)

                DeviceStore.apply("glasses", "fullyBooted", false)
                assertEquals(mapOf("state" to "idle"), glassesSnapshot()["audioSetup"])
                assertEquals(
                        listOf(mapOf("state" to "not_applicable"), mapOf("state" to "idle")),
                        audioSetupEvents(events),
                )
            }

    @Test fun `unknown capability without pairing_info is reported ready after 5 s as legacy`() =
            withLive(selectedCapability = "") { live, _ ->
                message(live, """{"type":"glasses_ready"}""")
                assertFalse(ready())
                assertEquals(mapOf("state" to "idle"), glassesSnapshot()["audioSetup"])
                idle(MentraLivePairingReadinessPolicy.UNKNOWN_CAPABILITY_PAIRING_INFO_WAIT_MS - 100)
                assertFalse(ready())
                idle(200)
                assertTrue(ready())
                assertEquals(mapOf("state" to "not_applicable"), glassesSnapshot()["audioSetup"])
                assertNull(get(live, "secureBondWaitRunnable"))
            }

    @Test fun `unknown capability with a secure pairing_info follows the owner commit rule`() =
            withLive(selectedCapability = "") { live, _ ->
                message(live, """{"type":"glasses_ready"}""")
                message(live, pairingInfo(secure = true, ownerCommitted = false))
                assertFalse(ready())
                // The secure rule runs its own deadline instead of the 5 s legacy fallback.
                assertNotNull(get(live, "secureBondWaitRunnable"))
                idle(MentraLivePairingReadinessPolicy.UNKNOWN_CAPABILITY_PAIRING_INFO_WAIT_MS + 1_000)
                assertFalse(ready())

                shadowOf(device()).setBondState(BluetoothDevice.BOND_BONDED)
                message(live, pairingInfo(secure = true, ownerCommitted = true))
                assertTrue(ready())
                assertNull(get(live, "secureBondWaitRunnable"))
            }

    @Test fun `unknown capability with a legacy pairing_info is ready at once`() =
            withLive(selectedCapability = "") { live, _ ->
                message(live, """{"type":"glasses_ready"}""")
                assertFalse(ready())
                message(live, pairingInfo(secure = false, ownerCommitted = false))
                assertTrue(ready())
            }

    @Test fun `a legacy row is not secure even if its address advertised the trailer before`() =
            withLive(selectedCapability = false) { live, _ ->
                trailerMemory().noteSecureTrailer(targetAddress)
                try {
                    message(live, """{"type":"glasses_ready"}""")
                    assertTrue(ready())
                    assertNull(get(live, "secureBondWaitRunnable"))
                } finally {
                    trailerMemory().onScanStart()
                }
            }

    @Test fun `a ready session without pairing_info clears the secure firmware memory after 15 s`() =
            withLive(selectedCapability = false) { live, _ ->
                DeviceStore.set("bluetooth", "mentra_live_secure_firmware", true)
                message(live, """{"type":"glasses_ready"}""")
                idle(MentraLivePairingReadinessPolicy.SECURE_FIRMWARE_REFRESH_MS - 100)
                assertEquals(true, DeviceStore.get("bluetooth", "mentra_live_secure_firmware"))
                idle(200)
                assertEquals(false, DeviceStore.get("bluetooth", "mentra_live_secure_firmware"))
            }

    @Test fun `a secure pairing_info keeps the secure firmware memory`() =
            withLive(selectedCapability = true) { live, _ ->
                DeviceStore.set("bluetooth", "mentra_live_secure_firmware", false)
                message(live, pairingInfo(secure = true, ownerCommitted = false))
                message(live, """{"type":"glasses_ready"}""")
                idle(MentraLivePairingReadinessPolicy.SECURE_FIRMWARE_REFRESH_MS + 1_000)
                assertEquals(true, DeviceStore.get("bluetooth", "mentra_live_secure_firmware"))
            }

    @Test fun `classic_link is accepted and logged`() =
            withLive(selectedCapability = false) { live, events ->
                message(live, """{"type":"classic_link","a2dp":true,"hfp":false}""")
                message(live, """{"type":"classic_link"}""")
                val logs = events.filter { it.first == "log" }.map { it.second["message"].toString() }
                assertTrue(logs.any { it.contains("LIVE: classic_link a2dp=true hfp=false") })
                assertTrue(logs.any { it.contains("LIVE: classic_link a2dp=false hfp=false") })
                assertFalse(ready())
            }

    private fun withLive(
            selectedCapability: Any,
            body: (MentraLive, MutableList<Pair<String, Map<String, Any>>>) -> Unit,
    ) {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        val saved = listOf("bluetooth", "glasses").associateWith { DeviceStore.store.getCategory(it) }
        val singleton = DeviceManager::class.java.getDeclaredField("_instance").apply { isAccessible = true }
        val previous = singleton.get(null)
        val manager = DeviceManager(initializeHardware = false)
        singleton.set(null, manager)
        MentraLivePairingStateStore.resetForTest()
        DeviceStore.set("glasses", "fullyBooted", false)
        DeviceStore.set("bluetooth", "pending_device_name", targetName)
        DeviceStore.set("bluetooth", "pending_device_address", targetAddress)
        DeviceStore.set("bluetooth", "pending_device_secure_pairing_capable", selectedCapability)
        val events = CopyOnWriteArrayList<Pair<String, Map<String, Any>>>()
        val sink = Bridge.addEventSink { type, body -> events.add(type to HashMap(body)) }
        val live = MentraLive()
        try {
            link(live)
            body(live, events)
        } finally {
            Bridge.removeEventSink(sink)
            live.destroy()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
            manager.cleanup()
            singleton.set(null, previous)
            MentraLivePairingStateStore.resetForTest()
            saved.forEach { (category, values) ->
                (DeviceStore.store.getCategory(category).keys - values.keys).forEach {
                    DeviceStore.store.remove(category, it)
                }
                values.forEach { (key, value) -> DeviceStore.set(category, key, value) }
            }
        }
    }

    private fun device(): BluetoothDevice = BluetoothAdapter.getDefaultAdapter().getRemoteDevice(targetAddress)

    /** A live GATT link to the pairing target; CTKD is marked started so no Classic work runs. */
    private fun link(live: MentraLive) {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        val gatt = device().connectGatt(context, false, object : BluetoothGattCallback() {})
        set(live, "isConnected", true)
        set(live, "bluetoothGatt", gatt)
        set(live, "connectedDevice", device())
        set(live, "txCharacteristic", BluetoothGattCharacteristic(UUID.randomUUID(), 0, 0))
        set(live, "ctkdInitiatedThisGattSession", true)
    }

    private fun message(live: MentraLive, json: String) {
        MentraLive::class.java.getDeclaredMethod("processJsonMessage", JSONObject::class.java)
                .apply { isAccessible = true }
                .invoke(live, JSONObject(json))
    }

    private fun pairingInfo(secure: Boolean, ownerCommitted: Boolean): String =
            """{"type":"pairing_info","secure_pairing_capable":$secure,"owner_committed":$ownerCommitted}"""

    private fun ready(): Boolean = DeviceStore.get("glasses", "fullyBooted") == true

    /** What `glasses_status` sends to JavaScript for the current store. */
    private fun glassesSnapshot(): Map<String, Any> =
            GlassesStatus.fromMap(DeviceStore.store.getCategory("glasses")).toMap()

    private fun audioSetupEvents(events: List<Pair<String, Map<String, Any>>>): List<Any?> =
            events.filter { it.first == "audio_setup_changed" }.map { it.second["state"] }

    private fun idle(ms: Long) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    private fun trailerMemory(): MentraLiveSecureTrailerScanMemory =
            MentraLive::class.java.getDeclaredField("secureTrailerScanMemory")
                    .apply { isAccessible = true }
                    .get(null) as MentraLiveSecureTrailerScanMemory

    private fun get(live: MentraLive, name: String): Any? =
            MentraLive::class.java.getDeclaredField(name).apply { isAccessible = true }.get(live)

    private fun set(live: MentraLive, name: String, value: Any?) {
        MentraLive::class.java.getDeclaredField(name).apply { isAccessible = true }.set(live, value)
    }
}
