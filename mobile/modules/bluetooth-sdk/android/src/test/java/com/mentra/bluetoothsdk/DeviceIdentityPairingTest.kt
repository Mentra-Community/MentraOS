package com.mentra.bluetoothsdk

import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.sgcs.Simulated
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
@LooperMode(LooperMode.Mode.PAUSED)
class DeviceIdentityPairingTest {
    @Test fun `readiness promotes a coherent name and address while preserving same-device reconnects`() {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        val saved = listOf("bluetooth", "glasses").associateWith { DeviceStore.store.getCategory(it) }
        val singleton = DeviceManager::class.java.getDeclaredField("_instance").apply { isAccessible = true }
        val previous = singleton.get(null)
        val cases = listOf(
            // pending name, pending address, saved model, expected address
            listOf("new", "", "test", ""),
            listOf("new", "new-address", "test", "new-address"),
            listOf("old", "", "test", "old-address"),
            listOf("", "", "test", "old-address"),
            listOf("old", "", "other-model", ""),
        )
        try {
            for ((pendingName, pendingAddress, savedModel, expectedAddress) in cases) {
                val manager = DeviceManager(initializeHardware = false)
                singleton.set(null, manager)
                manager.sgc = Simulated().apply { type = "test" }
                DeviceStore.set("bluetooth", "default_wearable", savedModel)
                DeviceStore.set("bluetooth", "device_name", "old")
                DeviceStore.set("bluetooth", "device_address", "old-address")
                DeviceStore.set("bluetooth", "pending_device_name", pendingName)
                DeviceStore.set("bluetooth", "pending_device_address", pendingAddress)
                DeviceStore.set("bluetooth", "shouldSendBootingMessage", false)
                try {
                    manager.handleDeviceReady()
                    assertEquals(pendingName.ifEmpty { "old" }, DeviceStore.get("bluetooth", "device_name"))
                    assertEquals(expectedAddress, DeviceStore.get("bluetooth", "device_address"))
                    assertEquals("", DeviceStore.get("bluetooth", "pending_device_name"))
                    assertEquals("", DeviceStore.get("bluetooth", "pending_device_address"))
                } finally {
                    manager.disconnect()
                    manager.cleanup()
                }
            }
        } finally {
            singleton.set(null, previous)
            saved.forEach { (category, values) ->
                (DeviceStore.store.getCategory(category).keys - values.keys).forEach { DeviceStore.store.remove(category, it) }
                values.forEach { (key, value) -> DeviceStore.set(category, key, value) }
            }
        }
    }
}
