package com.mentra.bluetoothsdk.drivers

import com.mentra.bluetoothsdk.BluetoothSdkDefaults
import com.mentra.bluetoothsdk.Bridge
import com.mentra.bluetoothsdk.DeviceManager
import com.mentra.bluetoothsdk.DeviceStore
import com.mentra.bluetoothsdk.utils.ConnTypes

/**
 * Concrete [DeviceHost] that routes a driver's callbacks into the real app
 * singletons (Bridge / DeviceStore / DeviceManager) — i.e. exactly the inline
 * calls RemoteHarness used to make, moved behind the façade. See the mapping
 * table in docs/device-driver-contract.md §6.
 *
 * @param deviceType the driver's type string, used as the model on touch events
 *                   (matches what RemoteHarness passed before).
 */
class DeviceHostImpl(private val deviceType: String) : DeviceHost {

    override fun reset() {
        DeviceStore.apply("glasses", "fullyBooted", false)
        DeviceStore.apply("glasses", "connected", false)
        DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTING)
        DeviceStore.apply("glasses", "micEnabled", false)
        DeviceStore.apply(
            "glasses",
            "voiceActivityDetectionEnabled",
            BluetoothSdkDefaults.VOICE_ACTIVITY_DETECTION_ENABLED,
        )
    }

    override fun reportConnectionState(state: ConnectionState) {
        when (state) {
            ConnectionState.CONNECTED -> {
                DeviceStore.apply("glasses", "connected", true)
                DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTED)
            }
            ConnectionState.CONNECTING -> {
                DeviceStore.apply("glasses", "connected", false)
                DeviceStore.apply("glasses", "connectionState", ConnTypes.CONNECTING)
            }
            ConnectionState.DISCONNECTED -> {
                DeviceStore.apply("glasses", "connected", false)
                DeviceStore.apply("glasses", "connectionState", ConnTypes.DISCONNECTED)
            }
        }
    }

    override fun reportReady(ready: Boolean) {
        DeviceStore.apply("glasses", "fullyBooted", ready)
    }

    override fun reportDeviceInfo(info: DeviceInfo) {
        DeviceStore.apply("glasses", "deviceModel", info.model)
        info.serial?.let { DeviceStore.apply("glasses", "serialNumber", it) }
        info.firmware?.let { DeviceStore.apply("glasses", "firmwareVersion", it) }
        info.color?.let { DeviceStore.apply("glasses", "color", it) }
        info.style?.let { DeviceStore.apply("glasses", "style", it) }
    }

    override fun emitBattery(level: Int, charging: Boolean) {
        DeviceStore.apply("glasses", "batteryLevel", level)
        DeviceStore.apply("glasses", "charging", charging)
        Bridge.sendBatteryStatus(level, charging)
    }

    override fun emitMicAudio(lc3: ByteArray, frameSize: Int) {
        DeviceManager.getInstance().handleGlassesMicData(lc3, frameSize)
    }

    override fun reportMicEnabled(on: Boolean) {
        DeviceStore.apply("glasses", "micEnabled", on)
    }

    override fun emitTouchEvent(gesture: String) {
        Bridge.sendTouchEvent(deviceType, gesture, System.currentTimeMillis(), 0)
    }

    override fun emitImu(
        accel: DoubleArray,
        gyro: DoubleArray,
        mag: DoubleArray,
        quat: DoubleArray,
        euler: DoubleArray,
    ) {
        Bridge.sendImuDataEvent(accel, gyro, mag, quat, euler, System.currentTimeMillis())
    }

    override fun reportCommandResult(requestId: String, ok: Boolean, error: String?) {
        Bridge.sendRgbLedControlResponse(requestId, ok, error)
    }

    override fun reportDiscoveredDevice(id: String, name: String) {
        Bridge.sendDiscoveredDevice(id, name)
    }

    override fun log(msg: String) {
        Bridge.log(msg)
    }
}
