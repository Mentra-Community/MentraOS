package com.mentra.bluetoothsdk.sgcs

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BesOtaHeartbeatGuardTest {
    @Test
    fun leaseSuppressesUntilDeadlineAndThenExpires() {
        val guard = BesOtaHeartbeatGuard(120_000)
        guard.refresh(1_000)

        assertTrue(guard.shouldSuppress(120_999))
        assertFalse(guard.shouldSuppress(121_000))
    }

    @Test
    fun progressRenewsLease() {
        val guard = BesOtaHeartbeatGuard(120_000)
        guard.refresh(1_000)
        guard.refresh(60_000)

        assertTrue(guard.shouldSuppress(121_000))
        assertFalse(guard.shouldSuppress(180_000))
    }

    @Test
    fun terminalStatusClearsLeaseImmediately() {
        val guard = BesOtaHeartbeatGuard(120_000)
        guard.refresh(1_000)
        guard.clear()

        assertFalse(guard.shouldSuppress(1_001))
    }
}
