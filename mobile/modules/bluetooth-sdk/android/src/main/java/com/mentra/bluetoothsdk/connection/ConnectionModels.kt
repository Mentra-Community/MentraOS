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
 * Completed and cancelled scans report [onComplete]. A failure to start reports
 * [onError] and is thrown to the caller. Optional empty-scan hints are delivered
 * separately through [ScanDiagnosticCallback], never as errors.
 */
interface ScanCallback {
    fun onResults(devices: List<Device>) {}
    fun onComplete(devices: List<Device>) {}
    fun onError(error: BluetoothError) {}
}

/** A non-fatal scan hint; it does not establish the cause of an empty result. */
data class ScanDiagnostic(val code: String, val message: String)

/**
 * Optional scan diagnostics, delivered before [onComplete] for an empty completed
 * scan. Kept separate so existing compiled [ScanCallback] implementations do not
 * need a new method. Android's `device_connected_on_phone` hint identifies a
 * model-compatible GATT connection on this phone, not which app owns it.
 */
interface ScanDiagnosticCallback : ScanCallback {
    fun onDiagnostic(diagnostic: ScanDiagnostic)
}

abstract class MentraBluetoothScanCallback : ScanDiagnosticCallback {
    override fun onDiagnostic(diagnostic: ScanDiagnostic) {}
}

/** Complete once, with an optional advisory that never replaces completion. */
internal fun ScanCallback.completeScan(
    reason: ScanStopReason,
    devices: List<Device>,
    diagnostic: () -> ScanDiagnostic?,
) {
    try {
        if (this is ScanDiagnosticCallback && reason == ScanStopReason.COMPLETED && devices.isEmpty()) {
            diagnostic()?.let { onDiagnostic(it) }
        }
    } finally {
        onComplete(devices)
    }
}

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
