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
    fun pauseIsTheWindowPlusTheCloseMarginWithNo300sClamp() {
        assertEquals(150_000L, MentraLiveOwnerLossPolicy.yieldMs(120_000L))
        // The glasses own the window: a longer one is paused for in full, not clamped to 300 s.
        assertEquals(930_000L, MentraLiveOwnerLossPolicy.yieldMs(900_000L))
        // A short window is not stretched to a floor either.
        assertEquals(40_000L, MentraLiveOwnerLossPolicy.yieldMs(10_000L))
        // A missing window falls back to the 120 s default.
        assertEquals(150_000L, MentraLiveOwnerLossPolicy.yieldMs(0L))
    }

    @Test
    fun aRestartedAppKeepsOnlyALiveDeadlineWithinThePersistedPause() {
        val now = 1_000_000L
        val pause = MentraLiveOwnerLossPolicy.yieldMs(120_000L)
        assertEquals(0L, MentraLiveOwnerLossPolicy.persistedYieldRemainingMs(0L, now, pause))
        assertEquals(50_000L, MentraLiveOwnerLossPolicy.persistedYieldRemainingMs(now + 50_000L, now, pause))
        assertEquals(pause, MentraLiveOwnerLossPolicy.persistedYieldRemainingMs(now + pause, now, pause))
        assertEquals(0L, MentraLiveOwnerLossPolicy.persistedYieldRemainingMs(now - 1L, now, pause))
        // Further out than the pause that was recorded with it: a clock change, not a window.
        assertEquals(0L, MentraLiveOwnerLossPolicy.persistedYieldRemainingMs(now + pause + 1L, now, pause))
        assertEquals(0L, MentraLiveOwnerLossPolicy.persistedYieldRemainingMs(now + 1_000L, now, 0L))
    }

    @Test
    fun theWindowRefusalStatus0x14IsNeverARejection() {
        assertFalse(gattRejection(0x14))
        assertFalse(MentraLiveOwnerLossPolicy.isOwnerRejectionStatus(0x14))
    }

    @Test
    fun pairSelectGoesOnlyWithAnExplicitAttemptToSecureGlasses() {
        assertTrue(MentraLiveOwnerLossPolicy.shouldSendPairSelect(explicitPairing = true, securePairingTarget = true))
        assertFalse(MentraLiveOwnerLossPolicy.shouldSendPairSelect(explicitPairing = false, securePairingTarget = true))
        assertFalse(MentraLiveOwnerLossPolicy.shouldSendPairSelect(explicitPairing = true, securePairingTarget = false))
        assertFalse(MentraLiveOwnerLossPolicy.shouldSendPairSelect(explicitPairing = false, securePairingTarget = false))
    }

    @Test
    fun parkedSecureReadinessAlwaysHasABondWaitDeadline() {
        // Nothing (no awaiting_confirm any more) suspends the wait on an explicit secure pair.
        assertTrue(MentraLiveOwnerLossPolicy.shouldRunSecureBondWait(explicitPairing = true, securePairingTarget = true))
        assertFalse(MentraLiveOwnerLossPolicy.shouldRunSecureBondWait(explicitPairing = false, securePairingTarget = true))
        assertFalse(MentraLiveOwnerLossPolicy.shouldRunSecureBondWait(explicitPairing = true, securePairingTarget = false))
        assertEquals(40_000L, MentraLiveOwnerLossPolicy.SECURE_BOND_WAIT_MS)
    }

    @Test
    fun explicitSecurePairDefersCtkdUntilPairingInfoArrives() {
        assertTrue(
                MentraLiveOwnerLossPolicy.shouldDeferCtkdBond(
                        explicitPairing = true,
                        secureTarget = true,
                        bondState = BluetoothDevice.BOND_NONE,
                        pairingInfoSeen = false,
                ),
        )
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldDeferCtkdBond(
                        explicitPairing = true,
                        secureTarget = true,
                        bondState = BluetoothDevice.BOND_NONE,
                        pairingInfoSeen = true,
                ),
        )
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldDeferCtkdBond(
                        explicitPairing = false,
                        secureTarget = true,
                        bondState = BluetoothDevice.BOND_NONE,
                        pairingInfoSeen = false,
                ),
        )
    }

    @Test
    fun automaticReconnectStandsDownWhileTheSavedGlassesAdvertisePairingMode() {
        assertTrue(
                MentraLiveOwnerLossPolicy.shouldStandDownInsteadOfReconnect(
                        pairingMode = true,
                        savedGlasses = true,
                        explicitPairing = false,
                )
        )
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldStandDownInsteadOfReconnect(
                        pairingMode = true,
                        savedGlasses = true,
                        explicitPairing = true,
                )
        )
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldStandDownInsteadOfReconnect(
                        pairingMode = false,
                        savedGlasses = true,
                        explicitPairing = false,
                )
        )
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldStandDownInsteadOfReconnect(
                        pairingMode = true,
                        savedGlasses = false,
                        explicitPairing = false,
                )
        )
    }

    @Test
    fun secureTargetIsNotReadyUntilBondedAndOwnerCommitted() {
        assertTrue(defer(bond = BluetoothDevice.BOND_BONDING, committed = true))
        assertTrue(defer(bond = BluetoothDevice.BOND_NONE, committed = true))
        assertTrue(defer(bond = BluetoothDevice.BOND_NONE, committed = false))
        assertFalse(defer(bond = BluetoothDevice.BOND_BONDED, committed = true))
        assertFalse(defer(secure = false, bond = BluetoothDevice.BOND_NONE, committed = false))
    }

    @Test
    fun staleBondWithoutOwnerCommitStillDefersAnExplicitSecurePair() {
        // A leftover BOND_BONDED (or a Classic-only bond on the same public address) is not
        // proof that the glasses committed this phone as owner.
        assertTrue(defer(bond = BluetoothDevice.BOND_BONDED, committed = false))
    }

    @Test
    fun bondedAndOwnerCommittedIsNotDeferred() {
        assertFalse(defer(bond = BluetoothDevice.BOND_BONDED, committed = true))
    }

    @Test
    fun lateOwnerCommitAfterBondAllowsReady() {
        // glasses_ready and the bond arrive first: parked.
        assertTrue(defer(bond = BluetoothDevice.BOND_BONDED, committed = false))
        // The late pairing_info carries owner_committed: ready is allowed now.
        assertTrue(MentraLiveOwnerLossPolicy.pairingInfoConfirmsOwner(true))
        assertFalse(defer(bond = BluetoothDevice.BOND_BONDED, committed = true))
    }

    @Test
    fun pairingInfoWithoutOwnerCommitDoesNotConfirmOwner() {
        assertFalse(MentraLiveOwnerLossPolicy.pairingInfoConfirmsOwner(false))
        assertTrue(MentraLiveOwnerLossPolicy.pairingInfoConfirmsOwner(true))
    }

    @Test
    fun legacyTargetIsNeverGated() {
        for (bond in listOf(BluetoothDevice.BOND_NONE, BluetoothDevice.BOND_BONDING, null)) {
            for (committed in listOf(true, false)) {
                assertFalse(defer(secure = false, bond = bond, committed = committed))
                assertTrue(audioReady(secure = false, bond = bond, committed = committed))
            }
        }
    }

    @Test
    fun classicAudioDoesNotCommitAnUnbondedSecurePair() {
        assertFalse(audioReady(bond = BluetoothDevice.BOND_BONDING, committed = false))
        assertFalse(audioReady(bond = BluetoothDevice.BOND_NONE, committed = false))
        assertTrue(audioReady(bond = BluetoothDevice.BOND_BONDED, committed = true))
    }

    @Test
    fun classicAudioFirstWithoutOwnerCommitDoesNotMarkReadyDuringExplicitPairing() {
        assertFalse(audioReady(bond = BluetoothDevice.BOND_BONDED, committed = false))
        // Once the commit arrives the same audio-first state may complete.
        assertTrue(audioReady(bond = BluetoothDevice.BOND_BONDED, committed = true))
    }

    @Test
    fun reconnectOutsideExplicitPairingIsNeverGated() {
        for (bond in listOf(BluetoothDevice.BOND_NONE, BluetoothDevice.BOND_BONDING, null)) {
            for (committed in listOf(true, false)) {
                assertTrue(audioReady(explicit = false, bond = bond, committed = committed))
            }
        }
    }

    private fun defer(
            secure: Boolean = true,
            bond: Int?,
            committed: Boolean,
    ): Boolean = MentraLiveOwnerLossPolicy.shouldDeferReadyForBond(secure, bond, committed)

    private fun audioReady(
            explicit: Boolean = true,
            secure: Boolean = true,
            bond: Int?,
            committed: Boolean,
    ): Boolean =
            MentraLiveOwnerLossPolicy.shouldMarkReadyFromAudio(
                    explicitPairing = explicit,
                    securePairingTarget = secure,
                    bondState = bond,
                    ownerCommitted = committed,
            )

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
