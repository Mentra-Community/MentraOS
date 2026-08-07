package com.mentra.bluetoothsdk.sgcs

internal data class BesOtaProgressMapping(
    val status: String,
    val progress: Int,
    val errorMessage: String? = null,
)

/** Map the BES sr_adota protocol without inferring terminal state from transfer progress. */
internal fun mapBesOtaProgress(
    type: String,
    rawProgress: Int,
    message: String?,
): BesOtaProgressMapping {
    val roundedProgress = (((rawProgress.coerceIn(0, 100) + 2) / 5) * 5).coerceAtMost(100)
    return when {
        type == "success" -> BesOtaProgressMapping("FINISHED", 100)
        type == "error" || type == "fail" ->
            BesOtaProgressMapping(
                "FAILED",
                roundedProgress,
                message?.takeIf { it.isNotBlank() } ?: "BES update failed",
            )
        // A raw update:100 is emitted before whole-image CRC/apply and is not terminal.
        else -> BesOtaProgressMapping("PROGRESS", minOf(roundedProgress, 95))
    }
}
