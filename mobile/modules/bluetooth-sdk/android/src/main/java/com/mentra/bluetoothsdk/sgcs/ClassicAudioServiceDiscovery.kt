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
    private class Pending(val device: BluetoothDevice, val ready: () -> Unit) {
        lateinit var timeout: Runnable
    }
    private var pending: Pending? = null

    fun connectWhenDiscovered(device: BluetoothDevice, ready: () -> Unit) {
        if (hasAudioSink(device)) {
            cancel()
            ready()
            return
        }
        if (pending?.device?.address == device.address) return
        cancel()
        val request = Pending(device, ready)
        request.timeout = Runnable {
            if (pending === request) {
                cancel()
                log("SDP timed out for ${device.address}; Classic audio remains disconnected")
            }
        }
        pending = request
        handler.postDelayed(request.timeout, timeoutMs)
        try {
            log("Refreshing Classic service UUIDs for ${device.address}")
            if (!device.fetchUuidsWithSdp()) {
                cancel()
                log("SDP request rejected for ${device.address}; Classic audio remains disconnected")
            }
        } catch (error: Exception) {
            cancel()
            log("SDP request failed for ${device.address}: ${error.message}")
        }
    }

    /** ACTION_UUID is a completion hint. Read the current OS cache, not a stale intent payload. */
    fun onUuids(device: BluetoothDevice) {
        val request = pending ?: return
        if (device.address != request.device.address) return
        cancel()
        if (hasAudioSink(request.device)) {
            log("Discovered A2DP Sink UUID for ${device.address}")
            request.ready()
        } else {
            log("SDP completed without A2DP Sink UUID for ${device.address}; Classic audio remains disconnected")
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
