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
    fun theFirstPairingModeDoesNotReleaseAndTheNextOneDoes() {
        val watch = PreviousOwnerRejectionWatch()
        assertFalse(watch.onAdvertisement(pairingMode = true, pairingGeneration = 1))
        assertFalse(watch.onEnteringPairingModeAgain())
        watch.beginFirstWindow()
        // The window we just stood down for is already advertising.
        assertFalse(watch.onAdvertisement(pairingMode = true, pairingGeneration = 1))
        assertFalse(watch.onAdvertisement(pairingMode = true, pairingGeneration = 1))
        // A second entry while that window is still up, seen as a new generation.
        assertTrue(watch.onAdvertisement(pairingMode = true, pairingGeneration = 2))
        assertFalse(watch.isActive)
    }

    @Test
    fun aQuietFirstWindowThenAnotherPairingModeReleases() {
        val watch = PreviousOwnerRejectionWatch()
        watch.beginFirstWindow()
        assertFalse(watch.onAdvertisement(pairingMode = true, pairingGeneration = 4))
        watch.noteQuiet()
        assertTrue(watch.isActive)
        assertTrue(watch.onAdvertisement(pairingMode = true, pairingGeneration = 4))
        assertFalse(watch.isActive)
    }

    @Test
    fun aSecondEnteringPairingModeReleasesWithoutAnAdvertisement() {
        val watch = PreviousOwnerRejectionWatch()
        watch.beginFirstWindow()
        assertTrue(watch.onEnteringPairingModeAgain())
        assertFalse(watch.isActive)
        assertFalse(watch.onEnteringPairingModeAgain())
    }

    @Test
    fun retainedOwnerLinkYieldsOnlyForAutomaticReconnect() {
        assertTrue(MentraLiveOwnerLossPolicy.shouldYieldForRetainedOwnerLink(true, false))
        assertFalse(MentraLiveOwnerLossPolicy.shouldYieldForRetainedOwnerLink(true, true))
        assertFalse(MentraLiveOwnerLossPolicy.shouldYieldForRetainedOwnerLink(false, false))
        assertFalse(MentraLiveOwnerLossPolicy.shouldYieldForRetainedOwnerLink(false, true))
    }

    @Test
    fun retainedOwnerWithoutAKeyStartsBondingOnExplicitPair() {
        assertTrue(
                MentraLiveOwnerLossPolicy.shouldStartBondForRetainedOwner(
                        true, true, BluetoothDevice.BOND_NONE)
        )
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldStartBondForRetainedOwner(
                        true, true, BluetoothDevice.BOND_BONDED)
        )
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldStartBondForRetainedOwner(
                        true, false, BluetoothDevice.BOND_NONE)
        )
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldStartBondForRetainedOwner(
                        false, true, BluetoothDevice.BOND_NONE)
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
    fun aRestartedAppKeepsOnlyALiveYieldDeadline() {
        val now = 1_000_000L
        assertEquals(0L, MentraLiveOwnerLossPolicy.persistedYieldRemainingMs(0L, now))
        assertEquals(50_000L, MentraLiveOwnerLossPolicy.persistedYieldRemainingMs(now + 50_000L, now))
        assertEquals(0L, MentraLiveOwnerLossPolicy.persistedYieldRemainingMs(now - 1L, now))
        assertEquals(
                0L,
                MentraLiveOwnerLossPolicy.persistedYieldRemainingMs(
                        now + MentraLiveOwnerLossPolicy.PAIRING_WINDOW_ABSOLUTE_MS + 1L,
                        now,
                )
        )
    }

    @Test
    fun enteringPairingModeYieldsOnlyWhenTheOwnerWasRetained() {
        assertTrue(MentraLiveOwnerLossPolicy.shouldYieldOnEnteringPairingMode(true))
        // Absent or false keeps the 3.3 stand-down.
        assertFalse(MentraLiveOwnerLossPolicy.shouldYieldOnEnteringPairingMode(false))
    }

    @Test
    fun rejectionsDuringAYieldAreNotRecorded() {
        assertFalse(MentraLiveOwnerLossPolicy.shouldRecordOwnerRejection(yieldActive = true))
        assertTrue(MentraLiveOwnerLossPolicy.shouldRecordOwnerRejection(yieldActive = false))
    }

    @Test
    fun yieldRejectionsNeverBuildAStreakThatStandsDown() {
        val streak = MentraLiveOwnerLossPolicy.OwnerRejectionStreak()
        var standDown = false
        var now = 0L
        // Rejections spanning well past the stand-down thresholds, all inside the yield.
        repeat(6) {
            if (MentraLiveOwnerLossPolicy.shouldRecordOwnerRejection(yieldActive = true)) {
                standDown = standDown || streak.record(now)
            }
            now += 60_000L
        }
        assertFalse(standDown)
        // The first rejection after the yield starts a fresh streak.
        assertFalse(streak.record(now))
    }

    @Test
    fun awaitingConfirmSuspendsTheSecureBondWait() {
        assertFalse(MentraLiveOwnerLossPolicy.shouldRunSecureBondWait(awaitingConfirm = true))
        assertTrue(MentraLiveOwnerLossPolicy.shouldRunSecureBondWait(awaitingConfirm = false))
    }

    @Test
    fun explicitSecurePairDefersCtkdUntilPairingInfoAllowsTheBond() {
        assertTrue(
                MentraLiveOwnerLossPolicy.shouldDeferCtkdBond(
                        explicitPairing = true,
                        secureTarget = true,
                        bondState = BluetoothDevice.BOND_NONE,
                        pairingInfoSeen = false,
                        awaitingConfirm = false,
                ),
        )
        assertTrue(
                MentraLiveOwnerLossPolicy.shouldDeferCtkdBond(
                        explicitPairing = true,
                        secureTarget = true,
                        bondState = BluetoothDevice.BOND_NONE,
                        pairingInfoSeen = true,
                        awaitingConfirm = true,
                ),
        )
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldDeferCtkdBond(
                        explicitPairing = true,
                        secureTarget = true,
                        bondState = BluetoothDevice.BOND_NONE,
                        pairingInfoSeen = true,
                        awaitingConfirm = false,
                ),
        )
        assertFalse(
                MentraLiveOwnerLossPolicy.shouldDeferCtkdBond(
                        explicitPairing = false,
                        secureTarget = true,
                        bondState = BluetoothDevice.BOND_NONE,
                        pairingInfoSeen = false,
                        awaitingConfirm = false,
                ),
        )
    }

    @Test
    fun awaitingConfirmDoesNotAcceptAReadySession() {
        assertFalse(MentraLiveOwnerLossPolicy.shouldAcceptReadyWhileAwaitingConfirm(awaitingConfirm = true))
        assertTrue(MentraLiveOwnerLossPolicy.shouldAcceptReadyWhileAwaitingConfirm(awaitingConfirm = false))
        assertEquals(20_000L, MentraLiveOwnerLossPolicy.CONFIRM_IGNORE_MS)
    }

    @Test
    fun successfulConfirmRearmsTheBondWaitButRefusalDoesNot() {
        assertTrue(MentraLiveOwnerLossPolicy.shouldRearmSecureBondWaitAfterConfirm(ok = true))
        assertFalse(MentraLiveOwnerLossPolicy.shouldRearmSecureBondWaitAfterConfirm(ok = false))
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
