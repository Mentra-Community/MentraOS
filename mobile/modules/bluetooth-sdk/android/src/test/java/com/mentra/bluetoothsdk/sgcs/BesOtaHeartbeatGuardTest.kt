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

    @Test
    fun besInstallStatusArmsLease() {
        val guard = BesOtaHeartbeatGuard(120_000)

        guard.observeOtaStatus("BES", "INSTALL", "in_progress", 1_000)

        assertTrue(guard.shouldSuppress(120_999))
    }

    @Test
    fun legacyBesInstallStatusUsesSameLease() {
        val guard = BesOtaHeartbeatGuard(120_000)

        guard.observeOtaStatus("bes", "install", "in_progress", 5_000)

        assertTrue(guard.shouldSuppress(124_999))
    }

    @Test
    fun unrelatedStatusDoesNotClearActiveLease() {
        val guard = BesOtaHeartbeatGuard(120_000)
        guard.observeOtaStatus("bes", "install", "in_progress", 1_000)

        guard.observeOtaStatus("apk", "install", "complete", 2_000)

        assertTrue(guard.shouldSuppress(120_999))
    }

    @Test
    fun besStepCompleteClearsLease() {
        val guard = BesOtaHeartbeatGuard(120_000)
        guard.observeOtaStatus("bes", "install", "in_progress", 1_000)

        guard.observeOtaStatus("bes", "install", "step_complete", 2_000)

        assertFalse(guard.shouldSuppress(2_001))
    }
}
