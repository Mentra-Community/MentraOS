package com.mentra.bluetoothsdk.sgcs

import android.bluetooth.BluetoothDevice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MentraLiveOwnerLossPolicyTest {
    @Test
    fun connectTimeRejectionIsAHintOnlyOutsideExplicitPairingOnSecureFirmware() {
        assertTrue(gattRejection(5))
        assertTrue(gattRejection(15))
        assertFalse(gattRejection(5, manualPairing = true))
    }

    @Test
    fun legacyFirmwareRejectionsAreNeverOwnerLoss() {
        assertFalse(gattRejection(5, secureFirmware = false))
        assertFalse(gattRejection(15, secureFirmware = false))
        assertFalse(bondRemoved(msSinceAutoReconnectLink = 600L, secureFirmware = false))
    }

    @Test
    fun rfDropsAndRemoteTerminationAreNotOwnerLoss() {
        for (status in listOf(8, 19, 22, 62, 133)) {
            assertFalse("status $status", gattRejection(status))
        }
    }

    @Test
    fun bondDroppedRightAfterAutomaticReconnectIsARejection() {
        assertTrue(bondRemoved(msSinceAutoReconnectLink = 600L))
    }

    @Test
    fun bondRemovalOutsideAReconnectIsNotARejection() {
        assertFalse(bondRemoved(msSinceAutoReconnectLink = null))
        assertFalse(bondRemoved(msSinceAutoReconnectLink = 60_000L))
    }

    @Test
    fun appUnpairAndExplicitPairingNeverReportOwnerLoss() {
        assertFalse(bondRemoved(msSinceAutoReconnectLink = 600L, killed = true))
        assertFalse(bondRemoved(msSinceAutoReconnectLink = 600L, unpairInProgress = true))
        assertFalse(bondRemoved(msSinceAutoReconnectLink = 600L, manualPairing = true))
    }

    @Test
    fun aSingleRejectionDoesNotStandDown() {
        val streak = MentraLiveOwnerLossPolicy.OwnerRejectionStreak()
        assertFalse(streak.record(0L))
    }

    @Test
    fun threeQuickRejectionsDoNotStandDownUntilTheStreakSpansAboutAMinute() {
        val streak = MentraLiveOwnerLossPolicy.OwnerRejectionStreak()
        assertFalse(streak.record(0L))
        assertFalse(streak.record(3_000L))
        // Third attempt, but a glasses reboot also rejects for a few seconds.
        assertFalse(streak.record(8_000L))
        assertFalse(streak.record(24_000L))
        assertTrue(streak.record(MentraLiveOwnerLossPolicy.MIN_REJECTION_SPAN_MS))
    }

    @Test
    fun aSuccessfulSessionEndsTheStreak() {
        val streak = MentraLiveOwnerLossPolicy.OwnerRejectionStreak()
        streak.record(0L)
        streak.record(10_000L)
        streak.reset()
        assertFalse(streak.record(50_000L))
        assertFalse(streak.record(60_000L))
    }

    @Test
    fun rejectionsFarApartAreNotOneStreak() {
        val streak = MentraLiveOwnerLossPolicy.OwnerRejectionStreak()
        streak.record(0L)
        streak.record(10_000L)
        streak.record(20_000L)
        // A long quiet gap means the earlier rejections were something else.
        val later = 20_000L + MentraLiveOwnerLossPolicy.REJECTION_STREAK_GAP_MS + 1L
        assertFalse(streak.record(later))
        assertFalse(streak.record(later + 10_000L))
        assertFalse(streak.record(later + 20_000L))
    }

    @Test
    fun oneAttemptReportingTwiceCountsOnce() {
        val streak = MentraLiveOwnerLossPolicy.OwnerRejectionStreak()
        val span = MentraLiveOwnerLossPolicy.MIN_REJECTION_SPAN_MS
        // Bond removed, then the GATT disconnect with status 5, for each of two attempts.
        // Counted per signal this would be four rejections over a long enough span.
        assertFalse(streak.record(0L))
        assertFalse(streak.record(400L))
        assertFalse(streak.record(span))
        assertFalse(streak.record(span + 400L))
        // A genuine third attempt completes the streak.
        assertTrue(streak.record(span + 10_000L))
    }

    @Test
    fun aFailedNewBondIsNotABondRemoval() {
        assertFalse(
                MentraLiveOwnerLossPolicy.isOwnerRejectionOnBondRemoved(
                        previousBondState = BluetoothDevice.BOND_BONDING,
                        bondState = BluetoothDevice.BOND_NONE,
                        killed = false,
                        unpairInProgress = false,
                        manualPairing = false,
                        msSinceAutoReconnectLink = 600L,
                        secureFirmware = true,
                )
        )
    }

    @Test
    fun yieldCoversTheAbsoluteWindow() {
        assertEquals(300_000L, MentraLiveOwnerLossPolicy.yieldMs(120_000L))
        assertEquals(300_000L, MentraLiveOwnerLossPolicy.yieldMs(900_000L))
    }

    @Test
    fun secureTargetIsNotReadyUntilBonded() {
        assertTrue(
                MentraLiveOwnerLossPolicy.shouldDeferReadyForBond(true, BluetoothDevice.BOND_BONDING)
        )
        assertTrue(MentraLiveOwnerLossPolicy.shouldDeferReadyForBond(true, BluetoothDevice.BOND_NONE))
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldDeferReadyForBond(true, BluetoothDevice.BOND_BONDED)
        )
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldDeferReadyForBond(false, BluetoothDevice.BOND_NONE)
        )
    }

    @Test
    fun classicAudioDoesNotCommitAnUnbondedSecurePair() {
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldMarkReadyFromAudio(
                        explicitPairing = true,
                        securePairingTarget = true,
                        bondState = BluetoothDevice.BOND_BONDING,
                )
        )
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldMarkReadyFromAudio(
                        explicitPairing = true,
                        securePairingTarget = true,
                        bondState = BluetoothDevice.BOND_NONE,
                )
        )
        assertTrue(
                MentraLiveOwnerLossPolicy.shouldMarkReadyFromAudio(
                        explicitPairing = true,
                        securePairingTarget = true,
                        bondState = BluetoothDevice.BOND_BONDED,
                )
        )
        assertTrue(
                MentraLiveOwnerLossPolicy.shouldMarkReadyFromAudio(
                        explicitPairing = false,
                        securePairingTarget = true,
                        bondState = BluetoothDevice.BOND_NONE,
                )
        )
    }

    private fun gattRejection(
            status: Int,
            manualPairing: Boolean = false,
            secureFirmware: Boolean = true,
    ): Boolean =
            MentraLiveOwnerLossPolicy.isOwnerRejectionOnGattError(
                    status,
                    manualPairing,
                    secureFirmware,
            )

    private fun bondRemoved(
            msSinceAutoReconnectLink: Long?,
            killed: Boolean = false,
            unpairInProgress: Boolean = false,
            manualPairing: Boolean = false,
            secureFirmware: Boolean = true,
    ): Boolean =
            MentraLiveOwnerLossPolicy.isOwnerRejectionOnBondRemoved(
                    previousBondState = BluetoothDevice.BOND_BONDED,
                    bondState = BluetoothDevice.BOND_NONE,
                    killed = killed,
                    unpairInProgress = unpairInProgress,
                    manualPairing = manualPairing,
                    msSinceAutoReconnectLink = msSinceAutoReconnectLink,
                    secureFirmware = secureFirmware,
            )
}
