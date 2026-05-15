package com.mentra.asg_client.camera.policy;

import android.hardware.camera2.CaptureResult;

/**
 * Phase 2a: AE convergence / lock state for the simplified XyCamera2-style photo pipeline.
 *
 * <p>Holds the {@link ShotState} enum, timing constants, human-readable AE state names, and the
 * pure decision function used by {@link CameraNeoService}'s repeating-request {@code CaptureCallback}.
 * Side effects (logging, {@code Handler#postDelayed}, {@code capturePhoto()}) stay in
 * {@link CameraNeoService}; this class only answers "what should happen next?".
 */
public final class AeStateMachine {

    /** Volatile: written from Bluetooth / main threads, read on camera {@link Handler} thread. */
    private volatile boolean waitingForAeConvergence;
    private volatile boolean aeLockRequested;
    private volatile long aeStartTimeNs;

    public boolean waitingForAeConvergence() {
        return waitingForAeConvergence;
    }

    public boolean aeLockRequested() {
        return aeLockRequested;
    }

    public void beginWaitingForAe() {
        waitingForAeConvergence = true;
        aeLockRequested = false;
        aeStartTimeNs = System.nanoTime();
    }

    public void skipAeForManualCapture() {
        waitingForAeConvergence = false;
        aeLockRequested = false;
        aeStartTimeNs = 0L;
    }

    public long elapsedNsSinceAeStart() {
        return System.nanoTime() - aeStartTimeNs;
    }

    public void markAeLockRequested() {
        aeLockRequested = true;
    }

    public void clearWaitFlags() {
        waitingForAeConvergence = false;
        aeLockRequested = false;
    }

    /**
     * Photo capture pipeline position. {@code WAITING_AE_LOCK} is only used when
     * {@link #USE_IMMEDIATE_CAPTURE_ON_CONVERGENCE} is {@code false}.
     */
    public enum ShotState {
        IDLE,
        WAITING_AE,
        WAITING_AE_LOCK,
        SHOOTING
    }

    /** Max wall time waiting for AE convergence before forcing still capture. */
    /**
     * Maximum time to wait for AE convergence before forcing a capture (2 seconds).
     * Renamed from {@code AE_WAIT_NS} during Phase 3.4 to reflect that it's an upper bound,
     * not a fixed wait. The previous name caused confusion ("wait for 1s" implied fixed delay).
     */
    public static final long AE_WAIT_MAX_NS = 2_000_000_000L;

    /**
     * When {@code true}: after AE converges, clear wait flags and schedule still capture after
     * {@link #EXPOSURE_STABILIZATION_DELAY_MS}. When {@code false}: request AE lock and wait for
     * {@link CaptureResult#CONTROL_AE_STATE_LOCKED} / {@link CaptureResult#CONTROL_AE_STATE_FLASH_REQUIRED}.
     */
    public static final boolean USE_IMMEDIATE_CAPTURE_ON_CONVERGENCE = true;

    /** Delay after AE converged before firing still capture (fast path). */
    public static final int EXPOSURE_STABILIZATION_DELAY_MS = 475;

    /**
     * Outcome of processing one {@code onCaptureCompleted} while waiting for AE (repeating
     * preview request with {@code mWaitingForAeConvergence == true}).
     */
    public enum AeRepeatCaptureDecision {
        /** Not waiting for AE — caller should return immediately. */
        IGNORE_NOT_WAITING,
        /** {@code CONTROL_AE_STATE} is null — keep waiting. */
        CONTINUE_WAITING_NULL_AE,
        /** Elapsed time exceeded {@link #AE_WAIT_MAX_NS} — clear wait/lock flags and capture. */
        CAPTURE_NOW_TIMEOUT,
        /** AE lock was requested and HAL reports locked/flash — clear flags and capture. */
        CAPTURE_NOW_LOCK_CONFIRMED,
        /** Lock requested but not yet confirmed — keep waiting (optional periodic logging in caller). */
        CONTINUE_WAITING_FOR_LOCK,
        /** AE converged (fast path) — clear flags and schedule capture after stabilization delay. */
        CAPTURE_AFTER_STABILIZATION_DELAY,
        /** AE converged (legacy path) — caller should call {@code requestAeLock(session)}. */
        REQUEST_AE_LOCK,
        /** AE not yet converged — keep waiting (optional periodic logging in caller). */
        CONTINUE_WAITING_FOR_CONVERGENCE
    }

    /**
     * Pure AE step: same control flow as the historical inline logic in
     * {@code CameraNeoService.SimplifiedAeCallback.onCaptureCompleted} (order preserved: not waiting →
     * null AE → timeout → lock branch → convergence branch).
     */
    public static AeRepeatCaptureDecision evaluateRepeatingRequestAeStep(
            boolean waitingForAeConvergence,
            boolean aeLockRequested,
            Integer aeState,
            long elapsedNsSinceAeStart) {
        if (!waitingForAeConvergence) {
            return AeRepeatCaptureDecision.IGNORE_NOT_WAITING;
        }
        // Match historical CameraNeoService order: null AE state returns before timeout is considered.
        if (aeState == null) {
            return AeRepeatCaptureDecision.CONTINUE_WAITING_NULL_AE;
        }
        if (elapsedNsSinceAeStart > AE_WAIT_MAX_NS) {
            return AeRepeatCaptureDecision.CAPTURE_NOW_TIMEOUT;
        }
        if (aeLockRequested) {
            if (aeState == CaptureResult.CONTROL_AE_STATE_LOCKED
                    || aeState == CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED) {
                return AeRepeatCaptureDecision.CAPTURE_NOW_LOCK_CONFIRMED;
            }
            return AeRepeatCaptureDecision.CONTINUE_WAITING_FOR_LOCK;
        }
        boolean isAeConverged = (aeState == CaptureResult.CONTROL_AE_STATE_CONVERGED
                || aeState == CaptureResult.CONTROL_AE_STATE_LOCKED);
        if (isAeConverged) {
            if (USE_IMMEDIATE_CAPTURE_ON_CONVERGENCE) {
                return AeRepeatCaptureDecision.CAPTURE_AFTER_STABILIZATION_DELAY;
            }
            return AeRepeatCaptureDecision.REQUEST_AE_LOCK;
        }
        return AeRepeatCaptureDecision.CONTINUE_WAITING_FOR_CONVERGENCE;
    }

    /** Human-readable AE state for logcat (handles null). */
    public static String getAeStateName(Integer aeState) {
        if (aeState == null) {
            return "null";
        }
        int s = aeState;
        switch (s) {
            case CaptureResult.CONTROL_AE_STATE_INACTIVE:
                return "INACTIVE";
            case CaptureResult.CONTROL_AE_STATE_SEARCHING:
                return "SEARCHING";
            case CaptureResult.CONTROL_AE_STATE_CONVERGED:
                return "CONVERGED";
            case CaptureResult.CONTROL_AE_STATE_LOCKED:
                return "LOCKED";
            case CaptureResult.CONTROL_AE_STATE_FLASH_REQUIRED:
                return "FLASH_REQUIRED";
            case CaptureResult.CONTROL_AE_STATE_PRECAPTURE:
                return "PRECAPTURE";
            default:
                return "UNKNOWN(" + s + ")";
        }
    }
}
