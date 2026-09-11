package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import java.util.UUID
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class MentraLiveGattCallbackTest {
    private fun gatt(): BluetoothGatt =
        BluetoothAdapter.getDefaultAdapter().getRemoteDevice("AA:BB:CC:DD:EE:FF")
            .connectGatt(RuntimeEnvironment.getApplication(), false, object : BluetoothGattCallback() {})

    private class RecordingCallback(
        enqueue: (() -> Unit) -> Unit,
        isCurrent: (BluetoothGatt) -> Boolean = { true },
    ) : SerializedGattCallback(enqueue, isCurrent) {
        val events = mutableListOf<String>()
        val packets = mutableListOf<ByteArray>()
        override fun handleConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) { events.add("connection") }
        override fun handleServicesDiscovered(gatt: BluetoothGatt, status: Int) { events.add("services") }
        override fun handlePhyUpdate(gatt: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int) { events.add("phyUpdate") }
        override fun handlePhyRead(gatt: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int) { events.add("phyRead") }
        override fun handleCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) { events.add("read") }
        override fun handleReadRemoteRssi(gatt: BluetoothGatt, rssi: Int, status: Int) { events.add("rssi") }
        override fun handleCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) { events.add("write") }
        override fun handleCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, data: ByteArray) { packets.add(data) }
        override fun handleDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) { events.add("descriptor") }
        override fun handleMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) { events.add("mtu") }
    }

    @Test
    fun `all callbacks defer effects until the lifecycle owner executes them`() {
        val queue = ArrayDeque<() -> Unit>()
        val callback = RecordingCallback({ work -> queue.addLast(work) })
        val gatt = gatt()
        val characteristic = BluetoothGattCharacteristic(UUID.randomUUID(), 0, 0)
        val descriptor = BluetoothGattDescriptor(UUID.randomUUID(), 0)
        callback.onConnectionStateChange(gatt, 0, 2)
        callback.onServicesDiscovered(gatt, 0)
        callback.onPhyUpdate(gatt, 1, 1, 0)
        callback.onPhyRead(gatt, 1, 1, 0)
        callback.onCharacteristicRead(gatt, characteristic, 0)
        callback.onReadRemoteRssi(gatt, -50, 0)
        callback.onCharacteristicWrite(gatt, characteristic, 0)
        callback.onDescriptorWrite(gatt, descriptor, 0)
        callback.onMtuChanged(gatt, 512, 0)
        assertEquals(emptyList<String>(), callback.events)
        while (queue.isNotEmpty()) queue.removeFirst().invoke()
        assertEquals(listOf("connection", "services", "phyUpdate", "phyRead", "read", "rssi", "write", "descriptor", "mtu"), callback.events)
    }

    @Test
    @Suppress("DEPRECATION")
    fun `queued notifications retain their own bytes when Android reuses characteristic`() {
        val queue = ArrayDeque<() -> Unit>()
        val callback = RecordingCallback({ work -> queue.addLast(work) })
        val gatt = gatt()
        val characteristic = BluetoothGattCharacteristic(UUID.randomUUID(), 0, 0)
        val buffer = byteArrayOf(1, 2)
        characteristic.value = buffer
        callback.onCharacteristicChanged(gatt, characteristic)
        buffer[0] = 3
        callback.onCharacteristicChanged(gatt, characteristic)
        buffer[0] = 4
        while (queue.isNotEmpty()) queue.removeFirst().invoke()
        assertArrayEquals(byteArrayOf(1, 2), callback.packets[0])
        assertArrayEquals(byteArrayOf(3, 2), callback.packets[1])
    }

    @Test
    fun `replacement invalidates callbacks already waiting on the lifecycle queue`() {
        val queue = ArrayDeque<() -> Unit>()
        var epoch = 1
        val callback = RecordingCallback({ work -> queue.addLast(work) }, { epoch == 1 })
        val gatt = gatt()
        callback.onConnectionStateChange(gatt, 0, 0)
        callback.onServicesDiscovered(gatt, 0)
        callback.onMtuChanged(gatt, 512, 0)
        epoch = 2
        while (queue.isNotEmpty()) queue.removeFirst().invoke()
        assertEquals(emptyList<String>(), callback.events)
    }
}
