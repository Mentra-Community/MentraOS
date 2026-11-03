package com.mentra.bluetoothsdk.utils

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IncidentLogBleRelayNamingTest {
    @Test fun `relay names built for a report are recognized`() {
        val firmware = IncidentLogBleRelayNaming.bleFileBaseName("rep_01M4HBVT88DFSN8TYNZ1WTV4PB", 'B')
        val logcat = IncidentLogBleRelayNaming.bleFileBaseName("rep_01M4HBVT88DFSN8TYNZ1WTV4PB", 'L')
        assertEquals("Brep_01m4hbvt88d", firmware)
        assertTrue(IncidentLogBleRelayNaming.isRelayFileName(firmware))
        assertTrue(IncidentLogBleRelayNaming.isRelayFileName(logcat))
        assertTrue(IncidentLogBleRelayNaming.isRelayFileName(IncidentLogBleRelayNaming.bleFileBaseName("short", 'B')))
    }

    @Test fun `photo and other transfers are not relays`() {
        for (name in listOf("I000123456", "I000123456.jpg", "ble_1234567890", "Brep_01m4hbvt88d.json", "Xrep_01m4hbvt88d", "", null)) {
            assertFalse(name.toString(), IncidentLogBleRelayNaming.isRelayFileName(name))
        }
    }
}
