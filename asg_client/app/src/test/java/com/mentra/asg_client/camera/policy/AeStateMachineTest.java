package com.mentra.asg_client.camera.policy;

import static org.assertj.core.api.Assertions.assertThat;

import android.hardware.camera2.CaptureResult;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;

/**
 * Unit tests for {@link AeStateMachine} pure AE step + AE state naming. Behavior must match the
 * historical inline order in {@code CameraNeoService.SimplifiedAeCallback.onCaptureCompleted}.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 33)
public class AeStateMachineTest {

    @Test
    public void evaluate_notWaiting_returnsIgnore() {
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                false, false, CaptureResult.CONTROL_AE_STATE_CONVERGED, 0L, 0, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.IGNORE_NOT_WAITING);
    }

    @Test
    public void evaluate_waitingNullAe_returnsBeforeTimeout() {
        // Even with huge elapsed, null AE must win (matches historical CameraNeoService order).
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, false, null, Long.MAX_VALUE, 0, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CONTINUE_WAITING_NULL_AE);
    }

    @Test
    public void evaluate_timeout_returnsCaptureTimeout() {
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, false, CaptureResult.CONTROL_AE_STATE_SEARCHING,
                AeStateMachine.AE_WAIT_MAX_NS + 1, 0, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CAPTURE_NOW_TIMEOUT);
    }

    @Test
    public void evaluate_lockRequestedLocked_returnsCaptureNow() {
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, true, CaptureResult.CONTROL_AE_STATE_LOCKED, 0L, 0, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CAPTURE_NOW_LOCK_CONFIRMED);
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, true, CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED, 0L, 0, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CAPTURE_NOW_LOCK_CONFIRMED);
    }

    @Test
    public void evaluate_lockRequestedNotLocked_returnsContinueLockWait() {
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, true, CaptureResult.CONTROL_AE_STATE_SEARCHING, 0L, 0, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CONTINUE_WAITING_FOR_LOCK);
    }

    @Test
    public void evaluate_convergedStableFrames_capturesNow() {
        assertThat(AeStateMachine.USE_IMMEDIATE_CAPTURE_ON_CONVERGENCE).isTrue();
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, false, CaptureResult.CONTROL_AE_STATE_CONVERGED, 0L,
                AeStateMachine.STABLE_FRAMES_REQUIRED, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CAPTURE_NOW_STABLE);
    }

    @Test
    public void evaluate_convergedNotYetStable_continuesWaitingForStability() {
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, false, CaptureResult.CONTROL_AE_STATE_CONVERGED, 0L,
                AeStateMachine.STABLE_FRAMES_REQUIRED - 1, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CONTINUE_WAITING_FOR_STABILITY);
    }

    @Test
    public void evaluate_convergedUnstableButCapReached_capturesNow() {
        // Oscillating exposure never yields enough stable frames — the historical fixed delay
        // acts as the ceiling so worst case matches the old behavior.
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, false, CaptureResult.CONTROL_AE_STATE_CONVERGED, 0L,
                1, AeStateMachine.EXPOSURE_STABILIZATION_DELAY_MS * 1_000_000L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CAPTURE_NOW_STABLE);
    }

    @Test
    public void evaluate_convergedLockedWithoutLockRequest_usesConvergedBranch() {
        // LOCKED is also "converged" in the boolean — fast path counts stability frames.
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, false, CaptureResult.CONTROL_AE_STATE_LOCKED, 0L,
                AeStateMachine.STABLE_FRAMES_REQUIRED, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CAPTURE_NOW_STABLE);
    }

    @Test
    public void evaluate_notConverged_returnsContinueConvergence() {
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, false, CaptureResult.CONTROL_AE_STATE_SEARCHING, 0L, 0, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CONTINUE_WAITING_FOR_CONVERGENCE);
    }

    @Test
    public void noteRepeatingFrame_countsStableConvergedFrames() {
        AeStateMachine sm = new AeStateMachine();
        sm.beginWaitingForAe();

        sm.noteRepeatingFrame(CaptureResult.CONTROL_AE_STATE_CONVERGED, 25_000_000L, 400);
        assertThat(sm.stableConvergedFrames()).isEqualTo(1);
        sm.noteRepeatingFrame(CaptureResult.CONTROL_AE_STATE_CONVERGED, 25_000_000L, 400);
        assertThat(sm.stableConvergedFrames()).isEqualTo(2);
        sm.noteRepeatingFrame(CaptureResult.CONTROL_AE_STATE_CONVERGED, 25_200_000L, 400);
        assertThat(sm.stableConvergedFrames()).isEqualTo(3);
        assertThat(sm.nsSinceFirstConverged()).isGreaterThan(0L);
    }

    @Test
    public void noteRepeatingFrame_exposureJumpResetsStabilityCount() {
        AeStateMachine sm = new AeStateMachine();
        sm.beginWaitingForAe();

        sm.noteRepeatingFrame(CaptureResult.CONTROL_AE_STATE_CONVERGED, 25_000_000L, 400);
        sm.noteRepeatingFrame(CaptureResult.CONTROL_AE_STATE_CONVERGED, 25_000_000L, 400);
        // >5% jump in exposure×ISO — restart the stable-frame streak at 1 (current frame).
        sm.noteRepeatingFrame(CaptureResult.CONTROL_AE_STATE_CONVERGED, 33_000_000L, 400);
        assertThat(sm.stableConvergedFrames()).isEqualTo(1);
    }

    @Test
    public void noteRepeatingFrame_leavingConvergedResetsStreakButKeepsCapWindow() {
        AeStateMachine sm = new AeStateMachine();
        sm.beginWaitingForAe();

        sm.noteRepeatingFrame(CaptureResult.CONTROL_AE_STATE_CONVERGED, 25_000_000L, 400);
        sm.noteRepeatingFrame(CaptureResult.CONTROL_AE_STATE_SEARCHING, 20_000_000L, 500);
        assertThat(sm.stableConvergedFrames()).isZero();
        // The stabilization cap keeps counting from FIRST convergence across AE flicker, so the
        // worst-case wait stays bounded by the historical fixed delay.
        assertThat(sm.nsSinceFirstConverged()).isGreaterThan(0L);
    }

    @Test
    public void noteRepeatingFrame_nullAeStateIsNoOp() {
        // Null AE state means "keep waiting" (CONTINUE_WAITING_NULL_AE) — it must not erase
        // streak progress accumulated between valid converged frames.
        AeStateMachine sm = new AeStateMachine();
        sm.beginWaitingForAe();

        sm.noteRepeatingFrame(CaptureResult.CONTROL_AE_STATE_CONVERGED, 25_000_000L, 400);
        sm.noteRepeatingFrame(CaptureResult.CONTROL_AE_STATE_CONVERGED, 25_000_000L, 400);
        sm.noteRepeatingFrame(null, null, null);
        assertThat(sm.stableConvergedFrames()).isEqualTo(2);
        assertThat(sm.nsSinceFirstConverged()).isGreaterThan(0L);
        sm.noteRepeatingFrame(CaptureResult.CONTROL_AE_STATE_CONVERGED, 25_000_000L, 400);
        assertThat(sm.stableConvergedFrames()).isEqualTo(3);
    }

    @Test
    public void noteRepeatingFrame_nullExposureStillCountsConvergedFrames() {
        // HALs that don't report SENSOR_* keys can't be verified — converged frames still count
        // so the capture isn't stuck waiting for data that never comes.
        AeStateMachine sm = new AeStateMachine();
        sm.beginWaitingForAe();

        sm.noteRepeatingFrame(CaptureResult.CONTROL_AE_STATE_CONVERGED, null, null);
        sm.noteRepeatingFrame(CaptureResult.CONTROL_AE_STATE_CONVERGED, null, null);
        sm.noteRepeatingFrame(CaptureResult.CONTROL_AE_STATE_CONVERGED, null, null);
        assertThat(sm.stableConvergedFrames()).isEqualTo(3);
    }

    @Test
    public void beginWaitingForAe_resetsStabilityTracking() {
        AeStateMachine sm = new AeStateMachine();
        sm.beginWaitingForAe();
        sm.noteRepeatingFrame(CaptureResult.CONTROL_AE_STATE_CONVERGED, 25_000_000L, 400);

        sm.beginWaitingForAe();

        assertThat(sm.stableConvergedFrames()).isZero();
        assertThat(sm.nsSinceFirstConverged()).isZero();
    }

    @Test
    public void getAeStateName_null() {
        assertThat(AeStateMachine.getAeStateName(null)).isEqualTo("null");
    }

    @Test
    public void getAeStateName_knownStates() {
        assertThat(AeStateMachine.getAeStateName(CaptureResult.CONTROL_AE_STATE_CONVERGED))
                .isEqualTo("CONVERGED");
        assertThat(AeStateMachine.getAeStateName(CaptureResult.CONTROL_AE_STATE_LOCKED))
                .isEqualTo("LOCKED");
    }

    @Test
    public void shotStateEnum_valuesUnchanged() {
        assertThat(AeStateMachine.ShotState.values())
                .containsExactly(
                        AeStateMachine.ShotState.IDLE,
                        AeStateMachine.ShotState.WAITING_AE,
                        AeStateMachine.ShotState.WAITING_AE_LOCK,
                        AeStateMachine.ShotState.SHOOTING);
    }

    @Test
    public void beginWaitingForAe_setsWaitStateAndElapsedTimer() {
        AeStateMachine stateMachine = new AeStateMachine();

        stateMachine.beginWaitingForAe();

        assertThat(stateMachine.waitingForAeConvergence()).isTrue();
        assertThat(stateMachine.aeLockRequested()).isFalse();
        assertThat(stateMachine.elapsedNsSinceAeStart()).isGreaterThanOrEqualTo(0L);
    }

    @Test
    public void markAeLockRequested_setsLockFlagWhileWaiting() {
        AeStateMachine stateMachine = new AeStateMachine();
        stateMachine.beginWaitingForAe();

        stateMachine.markAeLockRequested();

        assertThat(stateMachine.waitingForAeConvergence()).isTrue();
        assertThat(stateMachine.aeLockRequested()).isTrue();
    }

    @Test
    public void clearWaitFlags_clearsWaitingAndLockFlags() {
        AeStateMachine stateMachine = new AeStateMachine();
        stateMachine.beginWaitingForAe();
        stateMachine.markAeLockRequested();

        stateMachine.clearWaitFlags();

        assertThat(stateMachine.waitingForAeConvergence()).isFalse();
        assertThat(stateMachine.aeLockRequested()).isFalse();
    }

    @Test
    public void skipAeForManualCapture_clearsWaitingAndLockFlags() {
        AeStateMachine stateMachine = new AeStateMachine();
        stateMachine.beginWaitingForAe();
        stateMachine.markAeLockRequested();

        stateMachine.skipAeForManualCapture();

        assertThat(stateMachine.waitingForAeConvergence()).isFalse();
        assertThat(stateMachine.aeLockRequested()).isFalse();
    }
}
