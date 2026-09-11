package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor

/**
 * Binder callbacks only capture their arguments. Session validation and all callback effects run
 * on the lifecycle owner, in the same queue as connect and teardown. Notification bytes must be
 * copied before dispatch: Android reuses the mutable characteristic between notifications.
 */
internal abstract class SerializedGattCallback(
    private val enqueue: (() -> Unit) -> Unit,
    private val isCurrent: (BluetoothGatt) -> Boolean,
) : BluetoothGattCallback() {
    private fun dispatch(gatt: BluetoothGatt, work: () -> Unit) {
        enqueue { if (isCurrent(gatt)) work() }
    }

    final override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) =
        dispatch(gatt) { handleConnectionStateChange(gatt, status, newState) }

    final override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) =
        dispatch(gatt) { handleServicesDiscovered(gatt, status) }

    final override fun onPhyUpdate(gatt: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int) =
        dispatch(gatt) { handlePhyUpdate(gatt, txPhy, rxPhy, status) }

    final override fun onPhyRead(gatt: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int) =
        dispatch(gatt) { handlePhyRead(gatt, txPhy, rxPhy, status) }

    final override fun onCharacteristicRead(
        gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int,
    ) = dispatch(gatt) { handleCharacteristicRead(gatt, characteristic, status) }

    final override fun onReadRemoteRssi(gatt: BluetoothGatt, rssi: Int, status: Int) =
        dispatch(gatt) { handleReadRemoteRssi(gatt, rssi, status) }

    final override fun onCharacteristicWrite(
        gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int,
    ) = dispatch(gatt) { handleCharacteristicWrite(gatt, characteristic, status) }

    @Suppress("DEPRECATION")
    final override fun onCharacteristicChanged(
        gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic,
    ) {
        val value = characteristic.value?.copyOf() ?: return
        dispatch(gatt) { handleCharacteristicChanged(gatt, characteristic, value) }
    }

    final override fun onCharacteristicChanged(
        gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray,
    ) {
        val snapshot = value.copyOf()
        dispatch(gatt) { handleCharacteristicChanged(gatt, characteristic, snapshot) }
    }

    final override fun onDescriptorWrite(
        gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int,
    ) = dispatch(gatt) { handleDescriptorWrite(gatt, descriptor, status) }

    final override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) =
        dispatch(gatt) { handleMtuChanged(gatt, mtu, status) }

    protected abstract fun handleConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int)
    protected abstract fun handleServicesDiscovered(gatt: BluetoothGatt, status: Int)
    protected abstract fun handlePhyUpdate(gatt: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int)
    protected abstract fun handlePhyRead(gatt: BluetoothGatt, txPhy: Int, rxPhy: Int, status: Int)
    protected abstract fun handleCharacteristicRead(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int)
    protected abstract fun handleReadRemoteRssi(gatt: BluetoothGatt, rssi: Int, status: Int)
    protected abstract fun handleCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int)
    protected abstract fun handleCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, data: ByteArray)
    protected abstract fun handleDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int)
    protected abstract fun handleMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int)
}
