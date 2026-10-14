package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothDevice
import android.os.Handler
import android.os.ParcelUuid

/** One bounded SDP discovery; a BLE bond alone does not populate Android's Classic UUID cache. */
internal class ClassicAudioServiceDiscovery(
    private val handler: Handler,
    private val timeoutMs: Long,
    private val log: (String) -> Unit,
) {
    private class Pending(val device: BluetoothDevice, val unavailable: () -> Unit, val ready: () -> Unit) {
        lateinit var timeout: Runnable
    }
    private var pending: Pending? = null

    /** AUTO discovery on a dual-mode device with only LE connected searches GATT, not SDP.
     * Discover an existing bond's Classic services before opening our LE connection. A failed
     * discovery must still permit BLE; it must never manufacture an audio connection. */
    fun beforeBle(device: BluetoothDevice, ready: () -> Unit) {
        if (device.bondState != BluetoothDevice.BOND_BONDED ||
                device.type !in arrayOf(BluetoothDevice.DEVICE_TYPE_DUAL, BluetoothDevice.DEVICE_TYPE_CLASSIC)) {
            ready()
            return
        }
        connectWhenDiscovered(device, unavailable = ready, ready = ready)
    }

    fun connectWhenDiscovered(device: BluetoothDevice, unavailable: () -> Unit = {}, ready: () -> Unit) {
        if (hasAudioSink(device)) {
            cancel()
            ready()
            return
        }
        if (pending?.device?.address == device.address) return
        cancel()
        val request = Pending(device, unavailable, ready)
        request.timeout = Runnable {
            if (pending === request) {
                cancel()
                log("SDP timed out for ${device.address}; Classic audio remains disconnected")
                request.unavailable()
            }
        }
        pending = request
        handler.postDelayed(request.timeout, timeoutMs)
        val accepted = try {
            log("Refreshing Classic service UUIDs for ${device.address}")
            device.fetchUuidsWithSdp()
        } catch (error: Exception) {
            log("SDP request failed for ${device.address}: ${error.message}")
            false
        }
        if (!accepted) {
            cancel()
            log("SDP request rejected for ${device.address}; Classic audio remains disconnected")
            request.unavailable()
        }
    }

    /** ACTION_UUID is a completion hint. Read the current OS cache, not a stale intent payload. */
    fun onUuids(device: BluetoothDevice) {
        val request = pending ?: return
        if (device.address != request.device.address) return
        if (hasAudioSink(request.device)) {
            cancel()
            log("Discovered A2DP Sink UUID for ${device.address}")
            request.ready()
        } else {
            // Bonding can announce cached UUIDs before SDP finishes. Keep the original deadline.
            log("UUID event without A2DP Sink for ${device.address}; waiting for SDP within the existing deadline")
        }
    }

    fun cancel() {
        pending?.let { handler.removeCallbacks(it.timeout) }
        pending = null
    }

    companion object {
        private val AUDIO_SINK = ParcelUuid.fromString("0000110b-0000-1000-8000-00805f9b34fb")
        fun hasAudioSink(device: BluetoothDevice): Boolean = device.uuids?.contains(AUDIO_SINK) == true
    }
}
