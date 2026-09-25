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
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.utils.DeviceTypes
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
import org.robolectric.shadows.ShadowBluetoothGatt

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33], shadows = [G1PairingTest.ShadowLc3Cpp::class, MentraNexPairingTest.ShadowNexGatt::class], instrumentedPackages = ["com.mentra.lc3Lib"])
@LooperMode(LooperMode.Mode.PAUSED)
class MentraNexPairingTest {
    // Robolectric implements connection callbacks but not the PHY binder request.
    @Implements(BluetoothGatt::class)
    class ShadowNexGatt : ShadowBluetoothGatt() {
        @Implementation fun setPreferredPhy(txPhy: Int, rxPhy: Int, phyOptions: Int) {}
    }

    @Before fun setup() {
        Bridge.initialize(ApplicationProvider.getApplicationContext())
        shadowOf(BluetoothAdapter.getDefaultAdapter()).setState(BluetoothAdapter.STATE_ON)
        DeviceStore.set("bluetooth", "pending_device_name", "Nex1-2")
        DeviceStore.set("bluetooth", "pending_device_address", "")
        DeviceStore.set("bluetooth", "device_address", "")
    }

    @Test fun `fresh pairing selects only the requested Nex`() {
        assertScansSelectedTarget("", "")
    }

    @Test fun `simulated pairing selects only the requested Nex`() {
        assertScansSelectedTarget("Simulated Glasses", "")
    }

    @Test fun `a different saved Nex name and address cannot redirect selection`() {
        assertScansSelectedTarget("Nex1-1", "00:00:00:00:00:01")
    }

    @Test fun `pending address targets the new Nex instead of the saved pair`() {
        assertDirectTarget("Nex1-1", "00:00:00:00:00:01", "00:00:00:00:00:02")
    }

    @Test fun `saved Nex reconnect retains its address`() {
        assertDirectTarget("Nex1-2", "00:00:00:00:00:02", "")
    }

    @Test fun `name-only pairing readiness cannot associate the old MAC with the new Nex`() {
        DeviceStore.set("bluetooth", "default_wearable", DeviceTypes.NEX)
        DeviceStore.set("bluetooth", "pending_wearable", DeviceTypes.NEX)
        DeviceStore.set("bluetooth", "device_name", "Nex1-1")
        DeviceStore.set("bluetooth", "device_address", "00:00:00:00:00:01")
        DeviceStore.set("bluetooth", "shouldSendBootingMessage", false)
        DeviceStore.set("glasses", "fullyBooted", false)
        val old = device("00:00:00:00:00:01", "Nex1-1")
        val selected = device("00:00:00:00:00:02", "Nex1-2")
        val singleton = DeviceManager::class.java.getDeclaredField("_instance").apply { isAccessible = true }
        val previous = singleton.get(null)
        val manager = DeviceManager(initializeHardware = false)
        singleton.set(null, manager)
        try {
            var nex = MentraNex()
            manager.sgc = nex
            nex.connectById("Nex1-2")
            val scanner = shadowOf(BluetoothAdapter.getDefaultAdapter().bluetoothLeScanner)
            scanner.scanCallbacks.single().onScanResult(
                ScanSettings.CALLBACK_TYPE_ALL_MATCHES, ScanResult(selected, null, -50, 0),
            )
            shadowOf(Looper.getMainLooper()).idle()
            // Drive the actual ready callback and DeviceManager's identity promotion.
            shadowOf(selected).simulateGattConnectionChange(BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED)
            assertEquals("Nex1-2", DeviceStore.get("bluetooth", "device_name"))
            assertEquals("", DeviceStore.get("bluetooth", "device_address"))
            assertEquals("", DeviceStore.get("bluetooth", "pending_device_name"))
            manager.disconnect()

            nex = MentraNex()
            manager.sgc = nex
            nex.connectById(DeviceStore.get("bluetooth", "device_name") as String)
            assertTrue(shadowOf(old).bluetoothGatts.isEmpty())
            scanner.scanCallbacks.single().onScanResult(
                ScanSettings.CALLBACK_TYPE_ALL_MATCHES, ScanResult(selected, null, -50, 0),
            )
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(2, shadowOf(selected).bluetoothGatts.size)
        } finally {
            manager.disconnect()
            manager.cleanup()
            singleton.set(null, previous)
        }
    }

    private fun assertScansSelectedTarget(savedName: String, savedAddress: String) {
        DeviceStore.set("bluetooth", "device_name", savedName)
        DeviceStore.set("bluetooth", "device_address", savedAddress)
        val old = device("00:00:00:00:00:01", "Nex1-1")
        val prefixCollision = device("00:00:00:00:00:03", "Nex1-23")
        val selected = device("00:00:00:00:00:02", "Nex1-2")
        val nex = MentraNex()
        try {
            nex.connectById("Nex1-2")
            val scanner = shadowOf(BluetoothAdapter.getDefaultAdapter().bluetoothLeScanner)
            val callback = scanner.scanCallbacks.single()
            for (found in listOf(old, prefixCollision, selected)) {
                callback.onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, ScanResult(found, null, -50, 0))
                shadowOf(Looper.getMainLooper()).idle()
            }
            assertTrue(shadowOf(old).bluetoothGatts.isEmpty())
            assertTrue(shadowOf(prefixCollision).bluetoothGatts.isEmpty())
            assertEquals(1, shadowOf(selected).bluetoothGatts.size)
            assertEquals(savedName, DeviceStore.get("bluetooth", "device_name"))
        } finally { nex.disconnect() }
    }

    private fun assertDirectTarget(savedName: String, savedAddress: String, pendingAddress: String) {
        DeviceStore.set("bluetooth", "device_name", savedName)
        DeviceStore.set("bluetooth", "device_address", savedAddress)
        DeviceStore.set("bluetooth", "pending_device_address", pendingAddress)
        val old = device("00:00:00:00:00:01", "Nex1-1")
        val selected = device("00:00:00:00:00:02", "Nex1-2")
        val nex = MentraNex()
        try {
            nex.connectById("Nex1-2")
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(shadowOf(old).bluetoothGatts.isEmpty())
            assertEquals(1, shadowOf(selected).bluetoothGatts.size)
            assertEquals(savedName, DeviceStore.get("bluetooth", "device_name"))
        } finally { nex.disconnect() }
    }

    private fun device(address: String, name: String): BluetoothDevice =
        BluetoothAdapter.getDefaultAdapter().getRemoteDevice(address).also { shadowOf(it).setName(name) }
}
