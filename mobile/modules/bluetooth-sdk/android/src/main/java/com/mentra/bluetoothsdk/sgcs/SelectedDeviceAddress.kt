package com.mentra.bluetoothsdk.sgcs

/** An address is usable only when its accompanying name identifies the requested device. */
internal object SelectedDeviceAddress {
    fun resolve(
        target: String,
        pendingName: String?,
        pendingAddress: String?,
        savedName: String?,
        savedAddress: String?,
    ): String? {
        if (target.isBlank()) return null
        if (pendingName == target && !pendingAddress.isNullOrBlank()) return pendingAddress
        if (savedName == target && !savedAddress.isNullOrBlank()) return savedAddress
        return null
    }
}
