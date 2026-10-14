package com.mentra.bluetoothsdk

import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
@LooperMode(LooperMode.Mode.PAUSED)
class DeviceManagerOwnerLossTest {
    @Test fun `forgetting glasses clears the saved secure firmware flag`() {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        val saved = DeviceStore.store.getCategory("bluetooth")
        val manager = DeviceManager(initializeHardware = false)
        try {
            DeviceStore.set("bluetooth", "mentra_live_secure_firmware", true)
            manager.clearSecureFirmware()
            assertFalse(DeviceStore.store.get("bluetooth", "mentra_live_secure_firmware") as Boolean)
        } finally {
            manager.cleanup()
            (DeviceStore.store.getCategory("bluetooth").keys - saved.keys).forEach {
                DeviceStore.store.remove("bluetooth", it)
            }
            saved.forEach { (key, value) -> DeviceStore.set("bluetooth", key, value) }
        }
    }

    @Test fun `bluetooth-on still reaches the manager after owner loss so it can watch for the next pairing mode`() {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        val saved = DeviceStore.store.getCategory("bluetooth")
        val manager = DeviceManager(initializeHardware = false)
        try {
            DeviceStore.set("bluetooth", "default_wearable", "Mentra Live")
            DeviceStore.set("bluetooth", "device_name", "Mentra_Live_ABCD")

            DeviceStore.set("bluetooth", "mentra_live_owner_lost", true)
            assertTrue(manager.shouldReconnectAfterBluetoothOn())

            // SDK-only hosts have no engine to reset the flag; re-pairing or forgetting must.
            manager.clearOwnerLost()
            assertFalse(DeviceStore.store.get("bluetooth", "mentra_live_owner_lost") as Boolean)
            assertTrue(manager.shouldReconnectAfterBluetoothOn())
        } finally {
            manager.cleanup()
            (DeviceStore.store.getCategory("bluetooth").keys - saved.keys).forEach {
                DeviceStore.store.remove("bluetooth", it)
            }
            saved.forEach { (key, value) -> DeviceStore.set("bluetooth", key, value) }
        }
    }
}
