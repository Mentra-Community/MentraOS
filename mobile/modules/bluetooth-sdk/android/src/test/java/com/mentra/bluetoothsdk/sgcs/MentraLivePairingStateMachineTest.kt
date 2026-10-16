package com.mentra.bluetoothsdk.sgcs

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MentraLivePairingStateMachineTest {
    private val t0 = 1_700_000_000_000L
    private val device = "MENTRA_LIVE_BLE_ABCD"

    private fun enter(
            machine: MentraLivePairingStateMachine,
            windowId: Int? = 7,
            windowMs: Long? = 120_000L,
            ownerRetained: Boolean = true,
            explicit: Boolean = false,
            now: Long = t0,
    ) = machine.onEnteringPairingMode(windowMs, windowId, ownerRetained, explicit, device, now)

    private fun pausedMachine(windowId: Int = 7): MentraLivePairingStateMachine =
            MentraLivePairingStateMachine().also { enter(it, windowId = windowId) }

    private fun reject(machine: MentraLivePairingStateMachine, now: Long, explicit: Boolean = false) =
            machine.onAuthRejection(secureFirmware = true, explicitAttempt = explicit, nowMs = now)

    @Test
    fun v4NoticePausesForTheWindowPlusMarginWithoutA300sClamp() {
        val machine = MentraLivePairingStateMachine()
        val transition = enter(machine)
        assertEquals(MentraLivePairingEffect.PAUSE, transition.effect)
        assertEquals(MentraLivePairingState.PairingMode(7, t0 + 150_000L), machine.state)
        assertFalse(machine.allowsAutomaticReconnect)
        assertEquals(150_000L, machine.remainingPauseMs(t0))

        val long = MentraLivePairingStateMachine()
        enter(long, windowMs = 900_000L)
        assertEquals(MentraLivePairingState.PairingMode(7, t0 + 930_000L), long.state)
    }

    @Test
    fun publicStateMapsMatchTheTypeScriptContract() {
        assertEquals(mapOf("state" to "normal"), MentraLivePairingState.Normal.toMap())
        assertEquals(mapOf("state" to "pairing_rejected"), MentraLivePairingState.Rejected.toMap())
        assertEquals(
                mapOf("state" to "pairing_mode", "windowId" to 7, "endsAtMs" to t0),
                MentraLivePairingState.PairingMode(7, t0).toMap(),
        )
    }

    @Test
    fun aDuplicateNoticeForTheSameWindowIsIgnored() {
        val machine = pausedMachine()
        val again = enter(machine, now = t0 + 5_000L)
        assertEquals(MentraLivePairingEffect.NONE, again.effect)
        assertEquals(MentraLivePairingState.PairingMode(7, t0 + 150_000L), machine.state)
    }

    @Test
    fun anExplicitAttemptIsNeverPausedByTheNotice() {
        val machine = MentraLivePairingStateMachine()
        assertEquals(MentraLivePairingEffect.NONE, enter(machine, explicit = true).effect)
        assertEquals(MentraLivePairingState.Normal, machine.state)
    }

    @Test
    fun flagOffFirmwareForgetsThisPhoneOnEntry() {
        val machine = MentraLivePairingStateMachine()
        val transition = enter(machine, windowId = null, ownerRetained = false)
        assertEquals(MentraLivePairingEffect.REJECT, transition.effect)
        assertEquals(MentraLivePairingState.Rejected, machine.state)

        val pairing = MentraLivePairingStateMachine()
        enter(pairing, windowId = null, ownerRetained = false, explicit = true)
        assertEquals(MentraLivePairingState.Normal, pairing.state)
    }

    @Test
    fun pairingModeEndedResumesEarlyForTheMatchingWindowOnly() {
        val machine = pausedMachine()
        assertEquals(MentraLivePairingEffect.NONE, machine.onPairingModeEnded("timeout", 8).effect)
        assertTrue(machine.isPaused)
        val ended = machine.onPairingModeEnded("paired", 7)
        assertEquals(MentraLivePairingEffect.RESUME, ended.effect)
        assertEquals(MentraLivePairingState.Normal, machine.state)
        // The connected phone was admitted, so there is nothing to verify.
        assertNull(machine.endedWindowId)
    }

    @Test
    fun aClearedAdvertisementFlagResumesEarlyAfterTheGrace() {
        val machine = pausedMachine()
        // An advertisement from before the window opened can still be in flight.
        val early = machine.onAdvertisement(false, false, 6, t0 + 1_000L)
        assertEquals(MentraLivePairingEffect.NONE, early.effect)
        assertTrue(machine.isPaused)
        assertEquals(MentraLivePairingEffect.NONE, machine.onAdvertisement(true, false, 7, t0 + 20_000L).effect)
        val cleared = machine.onAdvertisement(false, false, 7, t0 + 60_000L)
        assertEquals(MentraLivePairingEffect.RESUME, cleared.effect)
        assertEquals(MentraLivePairingState.Normal, machine.state)
        assertEquals(7, machine.endedWindowId)
    }

    @Test
    fun theDeadlineResumes() {
        val machine = pausedMachine()
        assertEquals(MentraLivePairingEffect.NONE, machine.onTick(t0 + 149_999L).effect)
        assertEquals(MentraLivePairingEffect.RESUME, machine.onTick(t0 + 150_000L).effect)
        assertTrue(machine.allowsAutomaticReconnect)
        assertTrue(machine.awaitingTakeoverCheck)
    }

    @Test
    fun ownerChangedForTheEndedWindowRejectsOnTheFirstFailedVerification() {
        val machine = pausedMachine()
        machine.onTick(t0 + 150_000L)
        machine.onAdvertisement(false, ownerChanged = true, generation = 7, nowMs = t0 + 151_000L)
        assertTrue(machine.verificationArmed)
        assertFalse(machine.awaitingTakeoverCheck)
        val verdict = reject(machine, t0 + 152_000L)
        assertEquals(MentraLivePairingEffect.REJECT, verdict.effect)
        assertEquals(MentraLivePairingState.Rejected, machine.state)
    }

    @Test
    fun ownerChangedCarriedOnTheFlagClearingAdvertisementArmsTheVerification() {
        val machine = pausedMachine()
        val cleared = machine.onAdvertisement(false, ownerChanged = true, generation = 7, nowMs = t0 + 60_000L)
        assertEquals(MentraLivePairingEffect.RESUME, cleared.effect)
        assertTrue(machine.verificationArmed)
    }

    @Test
    fun aSpoofedOwnerChangedBitFollowedByASuccessfulReconnectDoesNotStrandThePhone() {
        val machine = pausedMachine()
        machine.onTick(t0 + 150_000L)
        machine.onAdvertisement(false, ownerChanged = true, generation = 7, nowMs = t0 + 151_000L)
        assertTrue(machine.verificationArmed)
        machine.onSessionReady(explicitAttempt = false)
        assertEquals(MentraLivePairingState.Normal, machine.state)
        assertFalse(machine.verificationArmed)
        // The same bit again arms nothing: exactly one verification per window.
        machine.onAdvertisement(false, ownerChanged = true, generation = 7, nowMs = t0 + 200_000L)
        assertFalse(machine.verificationArmed)
        assertEquals(MentraLivePairingEffect.NONE, reject(machine, t0 + 201_000L).effect)
        assertEquals(MentraLivePairingState.Normal, machine.state)
    }

    @Test
    fun ownerChangedForAnotherWindowOrStillInPairingModeArmsNothing() {
        val other = pausedMachine()
        other.onTick(t0 + 150_000L)
        other.onAdvertisement(false, ownerChanged = true, generation = 9, nowMs = t0 + 151_000L)
        assertFalse(other.verificationArmed)

        val stillPairing = pausedMachine()
        stillPairing.onAdvertisement(true, ownerChanged = true, generation = 7, nowMs = t0 + 60_000L)
        assertFalse(stillPairing.verificationArmed)

        // Without a window this phone paused for, the bit is not this phone's business.
        val idle = MentraLivePairingStateMachine()
        idle.onAdvertisement(false, ownerChanged = true, generation = 7, nowMs = t0)
        assertFalse(idle.verificationArmed)
    }

    @Test
    fun aVerificationThatFailsWithoutAnAuthVerdictFallsBackToTheStreak() {
        val machine = pausedMachine()
        machine.onTick(t0 + 150_000L)
        machine.onAdvertisement(false, ownerChanged = true, generation = 7, nowMs = t0 + 151_000L)
        machine.onConnectAttemptFailed()
        assertFalse(machine.verificationArmed)
        assertEquals(MentraLivePairingEffect.NONE, reject(machine, t0 + 160_000L).effect)
        assertEquals(MentraLivePairingState.Normal, machine.state)
    }

    @Test
    fun withoutTheBitThreeRejectionsSpanningTheMinimumReject() {
        val machine = MentraLivePairingStateMachine()
        assertEquals(MentraLivePairingEffect.NONE, reject(machine, t0).effect)
        assertEquals(MentraLivePairingEffect.NONE, reject(machine, t0 + 20_000L).effect)
        val third = reject(machine, t0 + MentraLiveOwnerLossPolicy.MIN_REJECTION_SPAN_MS)
        assertEquals(MentraLivePairingEffect.REJECT, third.effect)
        assertEquals(MentraLivePairingState.Rejected, machine.state)
    }

    @Test
    fun rejectionsDuringThePauseOrWhileThePairingAdvertIsFreshNeverCount() {
        val machine = pausedMachine()
        // The intentional disconnect and every 0x14/auth refusal inside the window.
        var now = t0
        repeat(6) {
            assertEquals(MentraLivePairingEffect.NONE, reject(machine, now).effect)
            now += 20_000L
        }
        assertTrue(machine.isPaused)

        val advertising = MentraLivePairingStateMachine()
        repeat(6) { i ->
            val at = t0 + i * 20_000L
            advertising.onAdvertisement(true, false, 3, at)
            assertEquals(MentraLivePairingEffect.NONE, reject(advertising, at + 1_000L).effect)
        }
        assertEquals(MentraLivePairingState.Normal, advertising.state)
        // The streak starts fresh once pairing mode is no longer advertised.
        advertising.onAdvertisement(false, false, 3, t0 + 200_000L)
        assertEquals(MentraLivePairingEffect.NONE, reject(advertising, t0 + 200_500L).effect)
        assertEquals(MentraLivePairingState.Normal, advertising.state)
    }

    @Test
    fun legacyFirmwareAndExplicitAttemptsNeverCount() {
        val machine = MentraLivePairingStateMachine()
        var now = t0
        repeat(6) {
            machine.onAuthRejection(secureFirmware = false, explicitAttempt = false, nowMs = now)
            reject(machine, now + 1, explicit = true)
            now += 20_000L
        }
        assertEquals(MentraLivePairingState.Normal, machine.state)
    }

    @Test
    fun onlyAnExplicitPairOrAForgetClearsARejection() {
        val machine = MentraLivePairingStateMachine()
        enter(machine, windowId = null, ownerRetained = false)
        machine.onSessionReady(explicitAttempt = false)
        assertEquals(MentraLivePairingState.Rejected, machine.state)
        machine.onPairingModeEnded("timeout", 1)
        machine.onTick(t0 + 1_000_000L)
        machine.onAdvertisement(false, false, 1, t0 + 1_000_000L)
        assertEquals(MentraLivePairingState.Rejected, machine.state)
        val paired = machine.onSessionReady(explicitAttempt = true)
        assertTrue(paired.stateChanged)
        assertEquals(MentraLivePairingState.Normal, machine.state)

        val forgotten = MentraLivePairingStateMachine()
        enter(forgotten, windowId = null, ownerRetained = false)
        forgotten.onForget()
        assertEquals(MentraLivePairingState.Normal, forgotten.state)
        assertEquals("", forgotten.deviceId)
    }

    @Test
    fun aPauseSurvivesARestartWithTheSameWindowId() {
        val machine = pausedMachine(windowId = 42)
        val persisted = machine.persisted()
        val restored = MentraLivePairingStateMachine()
        val transition = restored.restore(persisted, device, t0 + 30_000L)
        assertEquals(MentraLivePairingEffect.PAUSE, transition.effect)
        assertEquals(MentraLivePairingState.PairingMode(42, t0 + 150_000L), restored.state)
        assertEquals(120_000L, restored.remainingPauseMs(t0 + 30_000L))
    }

    @Test
    fun aPauseThatEndedWhileTheAppWasAwayStillVerifiesTheTakeover() {
        val persisted = pausedMachine(windowId = 42).persisted()
        val restored = MentraLivePairingStateMachine()
        val transition = restored.restore(persisted, device, t0 + 400_000L)
        assertEquals(MentraLivePairingEffect.NONE, transition.effect)
        assertEquals(MentraLivePairingState.Normal, restored.state)
        assertEquals(42, restored.endedWindowId)
        restored.onAdvertisement(false, ownerChanged = true, generation = 42, nowMs = t0 + 401_000L)
        assertTrue(restored.verificationArmed)
    }

    @Test
    fun anImplausibleRestoredDeadlineDoesNotPause() {
        val persisted = pausedMachine().persisted().toMutableMap()
        persisted[MentraLivePairingStateMachine.KEY_ENDS_AT_MS] = t0 + 10_000_000L
        val restored = MentraLivePairingStateMachine()
        restored.restore(persisted, device, t0)
        assertEquals(MentraLivePairingState.Normal, restored.state)
    }

    @Test
    fun aRejectionSurvivesARestart() {
        val machine = MentraLivePairingStateMachine()
        enter(machine, windowId = null, ownerRetained = false)
        val restored = MentraLivePairingStateMachine()
        val transition = restored.restore(machine.persisted(), device, t0 + 86_400_000L)
        assertEquals(MentraLivePairingEffect.REJECT, transition.effect)
        assertEquals(MentraLivePairingState.Rejected, restored.state)
    }

    @Test
    fun restoreIgnoresUnknownKeysAndMalformedValues() {
        val values =
                mapOf(
                        MentraLivePairingStateMachine.KEY_DEVICE_ID to device,
                        MentraLivePairingStateMachine.KEY_STATE to "pairing_mode",
                        MentraLivePairingStateMachine.KEY_WINDOW_ID to "not a number",
                        MentraLivePairingStateMachine.KEY_ENDS_AT_MS to t0 + 60_000L,
                        "pairing_v9_future_key" to "whatever",
                        "unrelated" to 12,
                )
        val restored = MentraLivePairingStateMachine()
        restored.restore(values, device, t0)
        assertEquals(MentraLivePairingState.Normal, restored.state)

        val future = MentraLivePairingStateMachine()
        future.restore(mapOf(MentraLivePairingStateMachine.KEY_STATE to "pairing_v9_state"), device, t0)
        assertEquals(MentraLivePairingState.Normal, future.state)
    }

    @Test
    fun aRecordForOtherGlassesDoesNotApply() {
        val persisted = pausedMachine().persisted()
        val restored = MentraLivePairingStateMachine()
        restored.restore(persisted, "MENTRA_LIVE_BLE_OTHER", t0 + 1_000L)
        assertEquals(MentraLivePairingState.Normal, restored.state)
        assertEquals("MENTRA_LIVE_BLE_OTHER", restored.deviceId)

        val bound = MentraLivePairingStateMachine()
        enter(bound, windowId = null, ownerRetained = false)
        assertTrue(bound.bindDevice("MENTRA_LIVE_BLE_OTHER").stateChanged)
        assertEquals(MentraLivePairingState.Normal, bound.state)
    }

    @Test
    fun theLegacyStandDownPhaseMigratesToRejected() {
        val restored = MentraLivePairingStateMachine()
        val transition =
                restored.restore(
                        mapOf(MentraLivePairingStateMachine.LEGACY_REJECTION_PHASE_KEY to "waiting"),
                        device,
                        t0,
                )
        assertEquals(MentraLivePairingEffect.REJECT, transition.effect)
        assertEquals(MentraLivePairingState.Rejected, restored.state)
    }
}
