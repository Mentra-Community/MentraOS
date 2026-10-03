package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.lc3Lib.Lc3Cpp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.Implements
import org.robolectric.annotation.LooperMode
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [G1PairingTest.ShadowLc3Cpp::class], instrumentedPackages = ["com.mentra.lc3Lib"])
@LooperMode(LooperMode.Mode.PAUSED)
class G1PairingTest {
    @Before
    fun setup() {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        shadowOf(BluetoothAdapter.getDefaultAdapter()).setState(BluetoothAdapter.STATE_ON)
    }

    @Test
    fun `fresh pairing connects the selected G1 without a saved identity`() {
        assertSelectedGlassesConnect("")
    }

    @Test
    fun `pairing from simulated glasses connects the selected G1`() {
        assertSelectedGlassesConnect("Simulated Glasses")
    }

    @Test
    fun `switching G1 pairs ignores the previously saved pair`() {
        assertSelectedGlassesConnect("12")
    }

    @Test
    fun `reconnecting the saved G1 still connects both halves`() {
        assertSelectedGlassesConnect("47")
    }

    private fun assertSelectedGlassesConnect(savedName: String) {
        DeviceStore.set("bluetooth", "device_name", savedName)
        DeviceStore.set("bluetooth", "pending_device_name", "47")
        val adapter = BluetoothAdapter.getDefaultAdapter()
        val scanner = shadowOf(adapter.bluetoothLeScanner)
        val glasses = G1()
        try {
            glasses.connectById("47")
            val callback = scanner.scanCallbacks.single()
            val unrelated = device("00:00:00:00:12:01", "Even G1_12_L_000001")
            val left = device("00:00:00:00:47:01", "Even G1_47_L_000001")
            val right = device("00:00:00:00:47:02", "Even G1_47_R_000002")

            for (device in listOf(unrelated, left, right)) {
                callback.onScanResult(
                    ScanSettings.CALLBACK_TYPE_ALL_MATCHES,
                    ScanResult(device, null, -50, 0),
                )
            }
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue("The previously saved pair must not receive a GATT connection", shadowOf(unrelated).bluetoothGatts.isEmpty())
            assertEquals("Connect the selected left half", 1, shadowOf(left).bluetoothGatts.size)
            shadowOf(left).simulateGattConnectionChange(BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED)
            shadowOf(Looper.getMainLooper()).idleFor(2, TimeUnit.SECONDS)
            assertEquals("Connect the selected right half", 1, shadowOf(right).bluetoothGatts.size)
            assertTrue("Stop scanning once both selected halves are found", scanner.scanCallbacks.isEmpty())
            assertEquals("Scanning must not promote an unready pairing", savedName, DeviceStore.get("bluetooth", "device_name"))
        } finally {
            glasses.disconnect()
        }
    }

    private fun device(address: String, name: String): BluetoothDevice =
        BluetoothAdapter.getDefaultAdapter().getRemoteDevice(address).also {
            shadowOf(it).setName(name)
            shadowOf(it).setAlias(name)
            shadowOf(it).setBondState(BluetoothDevice.BOND_BONDED)
        }

    // Pairing tests exercise the real G1 driver; only its unrelated native audio codec is stubbed.
    @Implements(Lc3Cpp::class)
    class ShadowLc3Cpp {
        companion object {
            @JvmStatic @Implementation fun __staticInitializer__() {}
            @JvmStatic @Implementation fun initDecoder(): Long = 1L
            @JvmStatic @Implementation fun freeDecoder(decoderPtr: Long) {}
        }
    }
}
