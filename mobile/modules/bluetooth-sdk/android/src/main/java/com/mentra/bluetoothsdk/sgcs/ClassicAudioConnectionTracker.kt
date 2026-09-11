package com.mentra.bluetoothsdk.sgcs

internal enum class ClassicAudioProfile {
    A2DP,
    HEADSET,
}

/** A confirmed connection is sufficient; declaring disconnection requires both profile reads. */
internal fun readyClassicAudioSnapshot(states: Map<ClassicAudioProfile, Boolean>): Set<ClassicAudioProfile>? {
    val connected = states.filterValues { it }.keys
    return if (connected.isNotEmpty() || states.size == ClassicAudioProfile.entries.size) connected else null
}

/**
 * Tracks the Android Classic audio profiles for one dual-mode glasses device.
 *
 * Android reports A2DP and HFP independently. Keeping both states prevents an A2DP disconnect from
 * publishing a false negative while HFP is still connected. Snapshot tickets reject obsolete
 * queries, including a previous session with the same MAC address. Broadcast payloads are not truth.
 */
internal class ClassicAudioConnectionTracker(
    private val onConnectedChanged: (Boolean) -> Unit,
) {
    private var targetAddress: String? = null
    private var revision = 0L
    private val connectedProfiles = mutableSetOf<ClassicAudioProfile>()

    @get:Synchronized
    val connected: Boolean
        get() = connectedProfiles.isNotEmpty()

    @Synchronized
    fun setTarget(address: String) {
        val normalizedAddress = address.normalizedBluetoothAddress()
        revision++
        if (targetAddress == normalizedAddress) return

        targetAddress = normalizedAddress
        clearConnectedProfiles()
    }

    @Synchronized
    fun beginSnapshot(address: String): Long? {
        if (targetAddress != address.normalizedBluetoothAddress()) return null
        return ++revision
    }

    /** Both profile queries must belong to the newest request for this session. */
    @Synchronized
    fun applySnapshot(
        ticket: Long,
        address: String,
        profiles: Set<ClassicAudioProfile>,
        onAccepted: () -> Unit = {},
    ): Boolean {
        if (ticket != revision || targetAddress != address.normalizedBluetoothAddress()) return false
        val wasConnected = this.connected
        connectedProfiles.clear()
        connectedProfiles.addAll(profiles)
        publishIfChanged(wasConnected)
        // Audio routing notifications must not race a target invalidation after validation.
        onAccepted()
        return true
    }

    @Synchronized
    fun clear(address: String): Boolean {
        if (targetAddress != address.normalizedBluetoothAddress()) return false
        revision++
        clearConnectedProfiles()
        return true
    }

    @Synchronized
    fun invalidate(address: String): Boolean {
        if (targetAddress != address.normalizedBluetoothAddress()) return false

        targetAddress = null
        revision++
        clearConnectedProfiles()
        return true
    }

    @Synchronized
    fun reset() {
        targetAddress = null
        revision++
        clearConnectedProfiles()
    }

    private fun clearConnectedProfiles() {
        val wasConnected = connected
        connectedProfiles.clear()
        publishIfChanged(wasConnected)
    }

    private fun publishIfChanged(wasConnected: Boolean) {
        if (wasConnected != connected) {
            onConnectedChanged(connected)
        }
    }
}

private fun String.normalizedBluetoothAddress(): String = trim().uppercase()
