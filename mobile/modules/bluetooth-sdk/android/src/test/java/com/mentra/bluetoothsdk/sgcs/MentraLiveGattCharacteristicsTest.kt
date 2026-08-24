package com.mentra.bluetoothsdk.sgcs

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MentraLiveGattCharacteristicsTest {
    @Test
    fun `accepts the core characteristic pair without requiring optional characteristics`() {
        assertTrue(
            hasRequiredMentraLiveCoreCharacteristics(
                hasRxCharacteristic = true,
                hasTxCharacteristic = true,
            )
        )
    }

    @Test
    fun `rejects an incomplete core characteristic pair`() {
        assertFalse(
            hasRequiredMentraLiveCoreCharacteristics(
                hasRxCharacteristic = false,
                hasTxCharacteristic = true,
            )
        )
        assertFalse(
            hasRequiredMentraLiveCoreCharacteristics(
                hasRxCharacteristic = true,
                hasTxCharacteristic = false,
            )
        )
        assertFalse(
            hasRequiredMentraLiveCoreCharacteristics(
                hasRxCharacteristic = false,
                hasTxCharacteristic = false,
            )
        )
    }
}
