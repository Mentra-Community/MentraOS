package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothGattCharacteristic
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.DeviceStore
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
@LooperMode(LooperMode.Mode.PAUSED)
class NimoMicReconnectTest {
    private val requests = listOf("should_send_lc3", "should_send_pcm", "should_send_transcript", "local_stt_fallback_active")

    @Test fun sameAdapterReconnectRestartsTheStoppedAudioClientForRetainedConsumers() {
        for (request in requests) withNimo { manager, device ->
            DeviceStore.apply("bluetooth", request, true)
            assertTrue(audioStarted(device))
            repeat(3) {
                resetLink(device)
                assertFalse(audioStarted(device))
                assertEquals(true, DeviceStore.get("bluetooth", request))
                // This is the same adapter, not the replacement fake used by the manager tests.
                DeviceStore.apply("glasses", "fullyBooted", true)
                assertSame(device, manager.sgc)
                assertTrue("Readiness must restart Nimo decoding without waiting for the watchdog", audioStarted(device))
            }
        }
    }

    @Test fun consumerStoppingDuringLinkLossDoesNotRestartAudio() = withNimo { _, device ->
        DeviceStore.apply("bluetooth", "should_send_pcm", true)
        assertTrue(audioStarted(device))
        resetLink(device)
        DeviceStore.apply("bluetooth", "should_send_pcm", false)
        DeviceStore.apply("glasses", "fullyBooted", true)
        assertFalse(audioStarted(device))
        assertEquals(false, DeviceStore.get("glasses", "micEnabled"))
    }

    private fun resetLink(device: Nimo) {
        // Exercise the production reset called by the GATT disconnect callback.
        Nimo::class.java.getDeclaredMethod("resetSessionState").apply { isAccessible = true }.invoke(device)
        DeviceStore.apply("glasses", "fullyBooted", false)
    }

    private fun audioStarted(device: Nimo): Boolean {
        val audio = Nimo::class.java.getDeclaredField("audioClient").apply { isAccessible = true }.get(device)
        return audio.javaClass.getDeclaredField("started").apply { isAccessible = true }.getBoolean(audio)
    }

    private fun withNimo(block: (DeviceManager, Nimo) -> Unit) {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        val singleton = DeviceManager::class.java.getDeclaredField("_instance").apply { isAccessible = true }
        val previous = singleton.get(null)
        val saved = listOf("bluetooth", "glasses").associateWith { DeviceStore.store.getCategory(it) }
        val manager = DeviceManager(initializeHardware = false)
        singleton.set(null, manager)
        val device = Nimo()
        manager.sgc = device
        // No radio/firmware: supply the discovered mic characteristic and inspect the real
        // audio-client lifecycle. Codec output and BLE delivery still require a device test.
        Nimo::class.java.getDeclaredField("micChar").apply { isAccessible = true }.set(
            device, BluetoothGattCharacteristic(UUID.randomUUID(), BluetoothGattCharacteristic.PROPERTY_WRITE, 0)
        )
        requests.forEach { DeviceStore.set("bluetooth", it, false) }
        DeviceStore.set("bluetooth", "micEnabled", false)
        DeviceStore.set("bluetooth", "micRanking", listOf("glasses"))
        DeviceStore.set("glasses", "micEnabled", false)
        DeviceStore.set("glasses", "fullyBooted", false)
        try {
            block(manager, device)
        } finally {
            device.cleanup()
            manager.sgc = null
            manager.cleanup()
            singleton.set(null, previous)
            saved.forEach { (category, values) ->
                DeviceStore.store.getCategory(category).keys.filter { it !in values }.forEach {
                    DeviceStore.store.remove(category, it)
                }
                values.forEach { (key, value) -> DeviceStore.set(category, key, value) }
            }
        }
    }
}
