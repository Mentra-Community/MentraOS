package com.mentra.bluetoothsdk.sgcs

internal data class BesOtaProgressMapping(
    val status: String,
    val progress: Int,
    val errorMessage: String? = null,
)

/**
 * BES reports transfer/apply acceptance directly over BLE, before the glasses power cycle. That
 * signal is useful progress but cannot prove which image booted. Only ASG's fresh sr_syvr readback
 * may produce phone-visible FINISHED/complete.
 */
internal fun mapBesOtaProgress(
    type: String,
    rawProgress: Int,
    roundedProgress: Int,
    message: String?,
): BesOtaProgressMapping {
    return when {
        type == "error" || type == "fail" ->
            BesOtaProgressMapping("FAILED", roundedProgress, message ?: "BES update failed")
        type == "success" || rawProgress >= 100 -> BesOtaProgressMapping("PROGRESS", 100)
        else -> BesOtaProgressMapping("PROGRESS", roundedProgress)
    }
}
