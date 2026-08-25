package com.mentra.bluetoothsdk

import org.assertj.core.api.Assertions.assertThat
import org.junit.Test

class OtaStartResponsePolicyTest {
    @Test
    fun batteryLowFailureRejectsPendingStart() {
        assertThat(otaStartRejectionErrorCode(status("failed", "battery_low")))
            .isEqualTo("battery_low")
    }

    @Test
    fun unrelatedFailureDoesNotRejectPendingStart() {
        assertThat(otaStartRejectionErrorCode(status("failed", "download_failed"))).isNull()
    }

    @Test
    fun nonFailureDoesNotRejectPendingStart() {
        assertThat(otaStartRejectionErrorCode(status("in_progress", "battery_low"))).isNull()
    }

    private fun status(status: String, errorMessage: String): OtaStatusEvent =
        OtaStatusEvent.fromMap(
            mapOf(
                "status" to status,
                "error_message" to errorMessage,
            )
        )
}
