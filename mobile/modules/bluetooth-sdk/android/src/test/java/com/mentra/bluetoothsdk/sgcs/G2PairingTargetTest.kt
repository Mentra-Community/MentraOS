package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanRecord
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Looper
import com.mentra.bluetoothsdk.Bridge
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.LooperMode
import org.robolectric.util.ReflectionHelpers
import org.robolectric.util.ReflectionHelpers.ClassParameter

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
@LooperMode(LooperMode.Mode.PAUSED)
class G2PairingTargetTest {
    @Before fun setup() {
        Bridge.initialize(RuntimeEnvironment.getApplication())
        shadowOf(BluetoothAdapter.getDefaultAdapter()).setState(BluetoothAdapter.STATE_ON)
    }

    @Test fun `unscoped legacy addresses cannot connect a different G2 pair`() {
        RuntimeEnvironment.getApplication().getSharedPreferences("G2Prefs", Context.MODE_PRIVATE).edit()
            .putString("g2_leftGlassAddress", "00:00:00:00:01:01")
            .putString("g2_rightGlassAddress", "00:00:00:00:01:02").apply()
        val g2 = G2()
        try {
            g2.connectById("S2NEW000000001")
            val adapter = BluetoothAdapter.getDefaultAdapter()
            assertTrue(shadowOf(adapter.getRemoteDevice("00:00:00:00:01:01")).bluetoothGatts.isEmpty())
            assertTrue(shadowOf(adapter.getRemoteDevice("00:00:00:00:01:02")).bluetoothGatts.isEmpty())
            assertEquals(1, shadowOf(adapter.bluetoothLeScanner).scanCallbacks.size)
        } finally { g2.disconnect() }
    }

    @Test fun `learned addresses reconnect only their own serial across driver recreation`() {
        val serial = "S2NEW000000001"
        val adapter = BluetoothAdapter.getDefaultAdapter()
        val left = adapter.getRemoteDevice("00:00:00:00:02:01")
        val right = adapter.getRemoteDevice("00:00:00:00:02:02")
        shadowOf(left).setName("Even G2_47_L_000001")
        shadowOf(right).setName("Even G2_47_R_000002")
        var g2 = G2()
        try {
            g2.connectById(serial)
            val callback = shadowOf(adapter.bluetoothLeScanner).scanCallbacks.single()
            // Manufacturer record: company ID 0x4552, followed by the advertised serial.
            val payload = byteArrayOf(0x52, 0x45) + serial.toByteArray(Charsets.US_ASCII)
            val record = ReflectionHelpers.callStaticMethod<ScanRecord>(
                ScanRecord::class.java, "parseFromBytes",
                ClassParameter.from(ByteArray::class.java, byteArrayOf((payload.size + 1).toByte(), 0xff.toByte()) + payload + byteArrayOf(0)),
            )
            for (device in listOf(left, right)) {
                callback.onScanResult(ScanSettings.CALLBACK_TYPE_ALL_MATCHES, ScanResult(device, record, -50, 0))
            }
            shadowOf(Looper.getMainLooper()).idle()
            for (device in listOf(left, right)) {
                assertEquals(1, shadowOf(device).bluetoothGatts.size)
                shadowOf(device).simulateGattConnectionChange(BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED)
            }
            shadowOf(Looper.getMainLooper()).idle()
            g2.disconnect()

            g2 = G2()
            g2.connectById("S2OTHER0000001")
            assertEquals(1, shadowOf(left).bluetoothGatts.size)
            assertEquals(1, shadowOf(right).bluetoothGatts.size)
            assertEquals(1, shadowOf(adapter.bluetoothLeScanner).scanCallbacks.size)
            g2.disconnect()

            g2 = G2()
            g2.connectById(serial)
            assertEquals(2, shadowOf(left).bluetoothGatts.size)
            assertEquals(2, shadowOf(right).bluetoothGatts.size)
            assertTrue(shadowOf(adapter.bluetoothLeScanner).scanCallbacks.isEmpty())
        } finally { g2.disconnect() }
    }
}
