package com.mentra.bluetoothsdk.sgcs

internal enum class ClassicAudioProfile {
    A2DP,
    HEADSET,
}

/**
 * Tracks the Android Classic audio profiles for one dual-mode glasses device.
 *
 * Android reports A2DP and HFP independently. Keeping both states prevents an A2DP disconnect from
 * publishing a false negative while HFP is still connected, and scoping every update to the target
 * address prevents late broadcasts from a previous glasses session from corrupting current state.
 */
internal class ClassicAudioConnectionTracker(
    private val onConnectedChanged: (Boolean) -> Unit,
) {
    private var targetAddress: String? = null
    private val connectedProfiles = mutableSetOf<ClassicAudioProfile>()

    val connected: Boolean
        get() = connectedProfiles.isNotEmpty()

    fun setTarget(address: String) {
        val normalizedAddress = address.normalizedBluetoothAddress()
        if (targetAddress == normalizedAddress) return

        targetAddress = normalizedAddress
        clearConnectedProfiles()
    }

    fun update(
        profile: ClassicAudioProfile,
        address: String,
        connected: Boolean,
    ): Boolean {
        if (targetAddress != address.normalizedBluetoothAddress()) return false

        val wasConnected = this.connected
        if (connected) {
            connectedProfiles.add(profile)
        } else {
            connectedProfiles.remove(profile)
        }
        publishIfChanged(wasConnected)
        return true
    }

    fun clear(address: String): Boolean {
        if (targetAddress != address.normalizedBluetoothAddress()) return false

        clearConnectedProfiles()
        return true
    }

    fun reset() {
        targetAddress = null
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
