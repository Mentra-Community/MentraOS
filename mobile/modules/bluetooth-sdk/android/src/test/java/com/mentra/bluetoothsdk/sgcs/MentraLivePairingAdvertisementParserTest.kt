package com.mentra.bluetoothsdk.sgcs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MentraLivePairingAdvertisementParserTest {
    @Test
    fun parsesMarkedSecurePairingAdvertisement() {
        val result = MentraLivePairingAdvertisementParser.parse(securePayload(pairingFlag = 1))

        assertEquals("1234", result?.pairingCode)
        assertTrue(result?.pairingMode == true)
    }

    @Test
    fun parsesMarkedOwnedAdvertisement() {
        val result = MentraLivePairingAdvertisementParser.parse(securePayload(pairingFlag = 0))

        assertEquals("1234", result?.pairingCode)
        assertFalse(result?.pairingMode == true)
    }

    @Test
    fun rejectsLegacyPayloadThatMatchesOldVersionCapabilityHeuristic() {
        val legacyPayload = ByteArray(27)
        legacyPayload[5] = 0
        legacyPayload[6] = 1
        legacyPayload[7] = 1
        legacyPayload[8] = 0x34
        legacyPayload[9] = 0x12

        assertNull(MentraLivePairingAdvertisementParser.parse(legacyPayload))
    }

    @Test
    fun rejectsUnmarkedFirstGenerationSecureTrailer() {
        val unmarkedPayload = securePayload(pairingFlag = 1)
        unmarkedPayload[10] = 0x11
        unmarkedPayload[11] = 0x22

        assertNull(MentraLivePairingAdvertisementParser.parse(unmarkedPayload))
    }

    @Test
    fun rejectsEveryLegacyVersionAndCapabilityCombination() {
        for (version in 0..255) {
            for (capability in 0..255) {
                val legacyPayload = ByteArray(27)
                legacyPayload[5] = 1
                legacyPayload[6] = version.toByte()
                legacyPayload[7] = capability.toByte()
                legacyPayload[10] = 0x4D
                // Offset 11 is padding in the legacy format, so it cannot contain the second
                // non-zero marker byte.
                legacyPayload[11] = 0
                assertNull(MentraLivePairingAdvertisementParser.parse(legacyPayload))
            }
        }
    }

    private fun securePayload(pairingFlag: Int): ByteArray {
        return ByteArray(27).also {
            it[5] = pairingFlag.toByte()
            it[6] = 2
            it[7] = 1
            it[8] = 0x34
            it[9] = 0x12
            it[10] = 0x4D
            it[11] = 0x50
        }
    }
}
