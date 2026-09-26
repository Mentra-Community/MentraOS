package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothAdapter
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceStore
import java.time.Duration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [G1PairingTest.ShadowLc3Cpp::class], instrumentedPackages = ["com.mentra.lc3Lib"])
@LooperMode(LooperMode.Mode.PAUSED)
class MentraLivePairingTargetTest {
    @Before fun setup() {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        shadowOf(BluetoothAdapter.getDefaultAdapter()).setState(BluetoothAdapter.STATE_ON)
        DeviceStore.set("bluetooth", "pending_device_name", "MENTRA_LIVE_NEW")
    }

    @Test fun `name-only selection scans instead of connecting the previous Live`() {
        assertTarget("MENTRA_LIVE_OLD", "00:00:00:00:00:01", "", scanExpected = true)
    }

    @Test fun `normal pairing connects the pending Live address`() {
        assertTarget("MENTRA_LIVE_OLD", "00:00:00:00:00:01", "00:00:00:00:00:02")
    }

    @Test fun `normal saved Live reconnect keeps the matching address`() {
        assertTarget("MENTRA_LIVE_NEW", "00:00:00:00:00:02", "")
    }

    private fun assertTarget(savedName: String, savedAddress: String, pendingAddress: String, scanExpected: Boolean = false) {
        DeviceStore.set("bluetooth", "device_name", savedName)
        DeviceStore.set("bluetooth", "device_address", savedAddress)
        DeviceStore.set("bluetooth", "pending_device_address", pendingAddress)
        val adapter = BluetoothAdapter.getDefaultAdapter()
        val old = adapter.getRemoteDevice("00:00:00:00:00:01")
        val selected = adapter.getRemoteDevice("00:00:00:00:00:02")
        shadowOf(old).setName("MENTRA_LIVE_OLD")
        shadowOf(selected).setName("MENTRA_LIVE_NEW")
        val live = MentraLive()
        try {
            live.connectById("MENTRA_LIVE_NEW")
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(shadowOf(old).bluetoothGatts.isEmpty())
            assertEquals(if (scanExpected) 0 else 1, shadowOf(selected).bluetoothGatts.size)
            assertEquals(if (scanExpected) 1 else 0, shadowOf(adapter.bluetoothLeScanner).scanCallbacks.size)
            assertEquals(savedName, DeviceStore.get("bluetooth", "device_name"))
        } finally {
            live.destroy()
            // Robolectric does not deliver the disconnect callback automatically.
            // Complete the production teardown timeout before another test connects.
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        }
    }
}
