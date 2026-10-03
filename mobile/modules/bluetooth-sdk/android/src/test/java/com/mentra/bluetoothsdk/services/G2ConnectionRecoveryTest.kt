package com.mentra.bluetoothsdk.services

import com.mentra.bluetoothsdk.utils.DeviceTypes
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class G2ConnectionRecoveryTest {
    private fun recovery() = G2ConnectionRecovery(RuntimeEnvironment.getApplication())
    private fun settings() = mapOf<String, Any>(
        "default_wearable" to DeviceTypes.G2, "device_name" to "S200-test",
        "brightness" to 75, "auto_brightness" to false,
        "core_token" to "must-not-persist", "micEnabled" to true,
        "searching" to true, "pending_device_name" to "unpaired",
    )

    @Before fun reset() { recovery().clear() }

    @Test fun `a fresh recovery owner restores identity and settings but not runtime or auth state`() {
        recovery().save(settings())
        val restored = recovery().read()!!
        assertEquals("S200-test", restored["device_name"])
        assertEquals(75, restored["brightness"])
        assertEquals(false, restored["auto_brightness"])
        assertFalse(restored.containsKey("core_token"))
        assertFalse(restored.containsKey("micEnabled"))
        assertFalse(restored.containsKey("searching"))
        assertFalse(restored.containsKey("pending_device_name"))
    }

    @Test fun `explicit disconnect clears recovery across owner recreation`() {
        recovery().save(settings())
        recovery().clear()
        assertNull(recovery().read())
    }

    @Test fun `forget or switching models cannot resurrect old G2 pairing`() {
        recovery().save(settings())
        recovery().save(settings() + ("device_name" to ""))
        assertNull(recovery().read())
        recovery().save(settings())
        recovery().save(settings() + ("default_wearable" to DeviceTypes.G1))
        assertNull(recovery().read())
    }
}
