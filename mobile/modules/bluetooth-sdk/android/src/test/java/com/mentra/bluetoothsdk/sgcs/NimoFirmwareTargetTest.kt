package com.mentra.bluetoothsdk.sgcs

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NimoFirmwareTargetTest {
    @Test fun acceptsOnlyTheSupportedBuild() {
        assertTrue(NimoFirmwareTarget.isCurrent("0.1.1.1", "FW-VERSION-v0.1.1.1-20260827164351-537cf1-dirty-Debug"))
        assertTrue(NimoFirmwareTarget.isCurrent("0.1.1.1", ""))
        assertFalse(NimoFirmwareTarget.isCurrent("0.1.1.1", "FW-VERSION-v0.1.1.1-20260101000000-abcdef-Release"))
        assertFalse(NimoFirmwareTarget.isCurrent("0.1.0.9", "FW-VERSION-v0.1.0.9-20250101000000-123456-Release"))
        assertFalse(NimoFirmwareTarget.isCurrent("", ""))
    }
}
