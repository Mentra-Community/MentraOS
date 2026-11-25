package com.mentra.bluetoothsdk

import org.junit.Assert.assertEquals
import org.junit.Test

class DeviceMapTest {
    /** The scan row that JS hands back to connect: the pairing flow needs its capability before pairing_info. */
    @Test fun `a selected scan row keeps its secure pairing capability`() {
        val row = Device(
                model = DeviceModel.MENTRA_LIVE,
                name = "Mentra_Live_0BB0",
                address = "AA:BB:CC:DD:0B:B0",
                pairingMode = true,
                pairingCode = "1A2B",
                securePairingCapable = true,
        )
        assertEquals(row, Device.fromMap(row.toMap()))
    }
}
