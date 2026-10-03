package com.mentra.bluetoothsdk.sgcs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SelectedDeviceAddressTest {
    @Test fun `selected pending address wins over saved address`() {
        assertEquals("new", SelectedDeviceAddress.resolve("LIVE_2", "LIVE_2", "new", "LIVE_1", "old"))
    }

    @Test fun `a name-only selection cannot use another device's saved address`() {
        assertNull(SelectedDeviceAddress.resolve("LIVE_2", "LIVE_2", "", "LIVE_1", "old"))
        assertNull(SelectedDeviceAddress.resolve("Nex1-2", "Nex1-2", null, "Nex1-1", "old"))
        assertNull(SelectedDeviceAddress.resolve("Nex1-2", null, null, "Simulated Glasses", ""))
    }

    @Test fun `saved reconnect keeps its address even with an unrelated pending selection`() {
        assertEquals("old", SelectedDeviceAddress.resolve("LIVE_1", "LIVE_2", "new", "LIVE_1", "old"))
        assertEquals("old", SelectedDeviceAddress.resolve("Nex1-1", null, null, "Nex1-1", "old"))
    }

    @Test fun `empty or mismatched identities never supply an address`() {
        assertNull(SelectedDeviceAddress.resolve("", "", "new", "", "old"))
        assertNull(SelectedDeviceAddress.resolve("LIVE_2", "LIVE_1", "new", "LIVE_1", "old"))
    }
}
