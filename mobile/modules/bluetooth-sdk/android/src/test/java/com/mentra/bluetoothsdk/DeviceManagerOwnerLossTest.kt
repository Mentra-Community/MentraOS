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
    @Test fun `owner loss blocks bluetooth-on reconnect until forget or re-pair clears it`() {
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
