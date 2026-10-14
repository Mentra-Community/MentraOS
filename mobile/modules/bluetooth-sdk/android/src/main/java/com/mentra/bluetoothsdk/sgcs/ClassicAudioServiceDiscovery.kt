package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothDevice
import android.os.Handler
import android.os.ParcelUuid

/** One bounded SDP discovery; a BLE bond alone does not populate Android's Classic UUID cache. */
internal class ClassicAudioServiceDiscovery(
    private val handler: Handler,
    private val timeoutMs: Long,
    private val log: (String) -> Unit,
    private val searchClassic: (BluetoothDevice, ParcelUuid) -> Boolean = { device, uuid ->
        // Unlike fetchUuidsWithSdp(AUTO), this searches SDP over BR/EDR even with LE up.
        // Some Android releases hide this API; callers retain the public discovery fallback.
        device.javaClass.getMethod("sdpSearch", ParcelUuid::class.java).invoke(device, uuid) as Boolean
    },
) {
    private class Pending(val device: BluetoothDevice, val unavailable: () -> Unit, val ready: () -> Unit) {
        lateinit var timeout: Runnable
        var refreshedOnClassic = false
    }
    private var pending: Pending? = null

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
        val classicAccepted = try {
            log("Requesting BR/EDR Audio Sink SDP for ${device.address}")
            searchClassic(device, AUDIO_SINK)
        } catch (error: Exception) {
            log("Explicit Classic SDP unavailable for ${device.address}: ${error.cause ?: error}")
            false
        }
        if (!classicAccepted) refreshUuids(request)
    }

    /** Refresh the UUID cache while the target's Classic ACL is live, so AUTO selects BR/EDR.
     * A transport connection or SDP record alone is never evidence that audio is ready. */
    fun onAclConnected(device: BluetoothDevice, transport: Int) {
        val request = pending ?: return
        if (device.address != request.device.address || transport != BluetoothDevice.TRANSPORT_BREDR ||
                request.refreshedOnClassic) return
        request.refreshedOnClassic = true
        refreshUuids(request)
    }

    private fun refreshUuids(request: Pending) {
        val device = request.device
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
