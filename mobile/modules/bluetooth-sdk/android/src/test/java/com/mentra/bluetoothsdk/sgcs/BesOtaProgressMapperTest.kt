package com.mentra.bluetoothsdk.sgcs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class BesOtaProgressMapperTest {
    @Test
    fun successIsNonterminalUntilAsgVerifiesRebootedVersion() {
        val mapping = mapBesOtaProgress("success", 0, 0, null)

        assertEquals("PROGRESS", mapping.status)
        assertEquals(100, mapping.progress)
        assertNull(mapping.errorMessage)
    }

    @Test
    fun hundredPercentUpdateIsAlsoNonterminal() {
        val mapping = mapBesOtaProgress("update", 100, 100, null)

        assertEquals("PROGRESS", mapping.status)
        assertEquals(100, mapping.progress)
    }

    @Test
    fun explicitBesErrorRemainsTerminalFailure() {
        val mapping = mapBesOtaProgress("error", 65, 65, "CRC failed")

        assertEquals("FAILED", mapping.status)
        assertEquals(65, mapping.progress)
        assertEquals("CRC failed", mapping.errorMessage)
    }
}
