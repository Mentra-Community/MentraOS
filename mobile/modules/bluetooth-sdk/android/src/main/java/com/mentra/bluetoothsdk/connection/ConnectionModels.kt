package com.mentra.bluetoothsdk

import com.mentra.bluetoothsdk.utils.ConnTypes
import java.util.concurrent.atomic.AtomicBoolean

enum class GlassesConnectionState(val value: String) {
    DISCONNECTED(ConnTypes.DISCONNECTED),
    SCANNING(ConnTypes.SCANNING),
    CONNECTING(ConnTypes.CONNECTING),
    BONDING(ConnTypes.BONDING),
    CONNECTED(ConnTypes.CONNECTED);

    val isConnected: Boolean
        get() = this == CONNECTED

    val isBusy: Boolean
        get() = this == SCANNING || this == CONNECTING || this == BONDING

    internal fun toStatusMap(
        connected: Boolean,
        fullyBooted: Boolean,
    ): Map<String, Any> =
        when {
            this == CONNECTED || connected || fullyBooted ->
                mapOf("state" to "connected", "fullyBooted" to fullyBooted)
            this == SCANNING -> mapOf("state" to "scanning")
            this == CONNECTING -> mapOf("state" to "connecting")
            this == BONDING -> mapOf("state" to "bonding")
            else -> mapOf("state" to "disconnected")
        }

    companion object {
        @JvmStatic
        fun fromValue(value: String?): GlassesConnectionState =
            optionalFromValue(value) ?: DISCONNECTED

        internal fun optionalFromValue(value: String?): GlassesConnectionState? {
            val normalized = value?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            return values().firstOrNull { it.value.equals(normalized, ignoreCase = true) }
        }
    }
}

data class BluetoothError(
    val code: String,
    val message: String,
    val cause: Throwable? = null,
)

enum class ScanStopReason {
    COMPLETED,
    CANCELLED,
    ERROR,
}

/**
 * Callbacks for `MentraBluetoothSdk.scan`.
 *
 * [onError] is not always terminal. A scan that fails to start reports the
 * failure through [onError] and [onComplete] never runs. A scan that runs to
 * completion always ends with [onComplete]; when it completes with zero
 * results while a compatible device is already GATT-connected by another app
 * on this phone, a non-terminal diagnostic error with code
 * `device_held_by_other_app` is delivered through [onError] immediately
 * before that [onComplete]. Discriminate on [BluetoothError.code], not on
 * [onError] having fired.
 */
interface ScanCallback {
    fun onResults(devices: List<Device>) {}
    fun onComplete(devices: List<Device>) {}
    fun onError(error: BluetoothError) {}
}

abstract class MentraBluetoothScanCallback : ScanCallback

class ScanSession internal constructor(
    private val stopAction: () -> Unit,
) {
    private val stopped = AtomicBoolean(false)

    fun stop() {
        if (stopped.compareAndSet(false, true)) {
            stopAction()
        }
    }

    internal fun markStopped() {
        stopped.set(true)
    }
}
