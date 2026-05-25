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
                false, false, CaptureResult.CONTROL_AE_STATE_CONVERGED, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.IGNORE_NOT_WAITING);
    }

    @Test
    public void evaluate_waitingNullAe_returnsBeforeTimeout() {
        // Even with huge elapsed, null AE must win (matches historical CameraNeoService order).
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, false, null, Long.MAX_VALUE))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CONTINUE_WAITING_NULL_AE);
    }

    @Test
    public void evaluate_timeout_returnsCaptureTimeout() {
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, false, CaptureResult.CONTROL_AE_STATE_SEARCHING,
                AeStateMachine.AE_WAIT_MAX_NS + 1))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CAPTURE_NOW_TIMEOUT);
    }

    @Test
    public void evaluate_lockRequestedLocked_returnsCaptureNow() {
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, true, CaptureResult.CONTROL_AE_STATE_LOCKED, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CAPTURE_NOW_LOCK_CONFIRMED);
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, true, CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CAPTURE_NOW_LOCK_CONFIRMED);
    }

    @Test
    public void evaluate_lockRequestedNotLocked_returnsContinueLockWait() {
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, true, CaptureResult.CONTROL_AE_STATE_SEARCHING, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CONTINUE_WAITING_FOR_LOCK);
    }

    @Test
    public void evaluate_convergedImmediateMode_returnsStabilizationDelay() {
        assertThat(AeStateMachine.USE_IMMEDIATE_CAPTURE_ON_CONVERGENCE).isTrue();
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, false, CaptureResult.CONTROL_AE_STATE_CONVERGED, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CAPTURE_AFTER_STABILIZATION_DELAY);
    }

    @Test
    public void evaluate_convergedLockedWithoutLockRequest_usesConvergedBranch() {
        // LOCKED is also "converged" in the boolean — fast path posts delayed capture.
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, false, CaptureResult.CONTROL_AE_STATE_LOCKED, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CAPTURE_AFTER_STABILIZATION_DELAY);
    }

    @Test
    public void evaluate_notConverged_returnsContinueConvergence() {
        assertThat(AeStateMachine.evaluateRepeatingRequestAeStep(
                true, false, CaptureResult.CONTROL_AE_STATE_SEARCHING, 0L))
                .isEqualTo(AeStateMachine.AeRepeatCaptureDecision.CONTINUE_WAITING_FOR_CONVERGENCE);
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
