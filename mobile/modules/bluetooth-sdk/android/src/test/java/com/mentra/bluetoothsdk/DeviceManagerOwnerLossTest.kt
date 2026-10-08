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
    @Test fun `bluetooth on does not reconnect glasses another phone now owns`() {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        val saved = DeviceStore.store.getCategory("bluetooth")
        // A Bluetooth OFF/ON cycle replaces the stood-down SGC with a fresh manager, so the
        // guard must come from the persisted flag rather than the killed instance.
        val manager = DeviceManager(initializeHardware = false)
        try {
            DeviceStore.set("bluetooth", "default_wearable", "Mentra Live")
            DeviceStore.set("bluetooth", "device_name", "Mentra_Live_ABCD")

            DeviceStore.set("bluetooth", "mentra_live_owner_lost", true)
            assertFalse(manager.shouldReconnectAfterBluetoothOn())

            DeviceStore.set("bluetooth", "mentra_live_owner_lost", false)
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
