package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothA2dp
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothHeadset
import android.bluetooth.BluetoothProfile
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceStore
import java.time.Duration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
import org.robolectric.shadows.ShadowBluetoothA2dp
import org.robolectric.shadows.ShadowBluetoothHeadset
import org.robolectric.util.ReflectionHelpers

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [G1PairingTest.ShadowLc3Cpp::class,
    MentraLiveClassicDisconnectTest.RecordingA2dp::class,
    MentraLiveClassicDisconnectTest.RecordingHeadset::class],
    instrumentedPackages = ["com.mentra.lc3Lib"])
@LooperMode(LooperMode.Mode.PAUSED)
class MentraLiveClassicDisconnectTest {
    private val adapter = BluetoothAdapter.getDefaultAdapter()
    private val target = adapter.getRemoteDevice("AA:BB:CC:DD:EE:FF")
    private val other = adapter.getRemoteDevice("11:22:33:44:55:66")
    private val a2dp = Shadow.newInstanceOf(BluetoothA2dp::class.java)
    private val headset = Shadow.newInstanceOf(BluetoothHeadset::class.java)
    private val audio: RecordingA2dp = Shadow.extract(a2dp)
    private val handsfree: RecordingHeadset = Shadow.extract(headset)

    @Before fun setup() {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        shadowOf(adapter).setState(BluetoothAdapter.STATE_ON)
        shadowOf(target).setName("MENTRA_LIVE_TEST")
        shadowOf(target).setBondState(BluetoothDevice.BOND_BONDED)
        DeviceStore.set("bluetooth", "device_name", "MENTRA_LIVE_TEST")
        DeviceStore.set("bluetooth", "device_address", target.address)
        DeviceStore.set("bluetooth", "pending_device_name", "MENTRA_LIVE_TEST")
        DeviceStore.set("bluetooth", "pending_device_address", target.address)
    }

    @Test fun `BLE loss followed by explicit disconnect releases both Classic profiles and keeps bond`() {
        assertDisconnect(dropBle = true)
    }

    @Test fun `explicit disconnect with BLE still connected releases both Classic profiles`() {
        assertDisconnect(dropBle = false)
    }

    private fun assertDisconnect(dropBle: Boolean) {
        val live = MentraLive()
        try {
            live.connectById("MENTRA_LIVE_TEST")
            shadowOf(Looper.getMainLooper()).idle()
            shadowOf(target).simulateGattConnectionChange(BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED)
            shadowOf(Looper.getMainLooper()).idle()
            if (dropBle) {
                shadowOf(target).simulateGattConnectionChange(BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_DISCONNECTED)
                shadowOf(Looper.getMainLooper()).idle()
                assertNull(ReflectionHelpers.getField<BluetoothDevice?>(live, "connectedDevice"))
            }
            installConnectedProfiles()
            live.disconnect()
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(listOf(target), audio.disconnected)
            assertEquals(listOf(target), handsfree.disconnected)
            assertEquals(BluetoothProfile.STATE_CONNECTED, a2dp.getConnectionState(other))
            assertEquals(BluetoothProfile.STATE_CONNECTED, headset.getConnectionState(other))
            assertEquals(BluetoothDevice.BOND_BONDED, target.bondState)
        } finally {
            live.destroy()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        }
    }

    @Test fun `a manager with no connection session does not disconnect an unrelated bonded device`() {
        val live = MentraLive()
        try {
            installConnectedProfiles()
            live.disconnect()
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(emptyList<BluetoothDevice>(), audio.disconnected)
            assertEquals(emptyList<BluetoothDevice>(), handsfree.disconnected)
        } finally {
            live.destroy()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        }
    }

    private fun installConnectedProfiles() {
        for (device in listOf(target, other)) {
            audio.addDevice(device, BluetoothProfile.STATE_CONNECTED)
            handsfree.addDevice(device, BluetoothProfile.STATE_CONNECTED)
        }
        shadowOf(adapter).setProfileProxy(BluetoothProfile.A2DP, a2dp)
        shadowOf(adapter).setProfileProxy(BluetoothProfile.HEADSET, headset)
    }

    // The real MentraLive lifecycle runs; only Android's audio profile services are simulated.
    @Implements(BluetoothA2dp::class)
    class RecordingA2dp : ShadowBluetoothA2dp() {
        val disconnected = mutableListOf<BluetoothDevice>()
        @Implementation fun disconnect(device: BluetoothDevice): Boolean {
            disconnected.add(device)
            removeDevice(device)
            return true
        }
    }

    @Implements(BluetoothHeadset::class)
    class RecordingHeadset : ShadowBluetoothHeadset() {
        val disconnected = mutableListOf<BluetoothDevice>()
        @Implementation fun disconnect(device: BluetoothDevice): Boolean {
            disconnected.add(device)
            removeDevice(device)
            return true
        }
    }
}
