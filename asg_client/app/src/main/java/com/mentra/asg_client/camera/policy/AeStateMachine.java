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

    /**
     * Wall time of the first converged frame in the current wait; 0 = not converged yet. Once
     * set it survives AE flicker (converged → searching → converged) so the
     * {@link #EXPOSURE_STABILIZATION_DELAY_MS} cap is measured from first convergence — matching
     * the historical fixed-delay worst case. Only {@link #beginWaitingForAe()} resets it.
     */
    private volatile long firstConvergedNs;
    /** Consecutive converged frames whose exposure×ISO stayed within tolerance. */
    private volatile int stableConvergedFrames;
    /** exposure×ISO of the previous converged frame; 0 = none / HAL not reporting. */
    private volatile long lastTotalLight;

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
        firstConvergedNs = 0L;
        stableConvergedFrames = 0;
        lastTotalLight = 0L;
    }

    /**
     * Record one repeating-request frame while waiting for AE. Tracks how long AE has been
     * converged and how many consecutive converged frames had stable exposure, so the still
     * capture can fire as soon as exposure has actually settled instead of after a fixed delay.
     *
     * <p>Call from the camera {@link Handler} thread only (same thread as the capture callback).
     */
    public void noteRepeatingFrame(Integer aeState, Long exposureNs, Integer iso) {
        if (aeState == null) {
            // Matches AeRepeatCaptureDecision.CONTINUE_WAITING_NULL_AE: a frame with no AE state
            // is "keep waiting", not evidence that AE left convergence — don't touch the streak.
            return;
        }
        boolean converged = aeState == CaptureResult.CONTROL_AE_STATE_CONVERGED
                || aeState == CaptureResult.CONTROL_AE_STATE_LOCKED;
        if (!converged) {
            // AE regressed (e.g. scene change mid-wait): restart the stability streak, but keep
            // firstConvergedNs so the stabilization cap still bounds this wait at the historical
            // fixed delay instead of stretching toward the 2s AE timeout.
            stableConvergedFrames = 0;
            lastTotalLight = 0L;
            return;
        }
        if (firstConvergedNs == 0L) {
            firstConvergedNs = System.nanoTime();
        }
        long totalLight = (exposureNs != null && iso != null && exposureNs > 0 && iso > 0)
                ? exposureNs * iso
                : 0L;
        boolean stable;
        if (totalLight == 0L || lastTotalLight == 0L) {
            // First converged frame, or HAL doesn't report exposure — nothing to compare against.
            stable = true;
        } else {
            long delta = Math.abs(totalLight - lastTotalLight);
            stable = delta <= (long) (lastTotalLight * STABILITY_TOLERANCE);
        }
        stableConvergedFrames = stable ? stableConvergedFrames + 1 : 1;
        if (totalLight != 0L) {
            lastTotalLight = totalLight;
        }
    }

    public int stableConvergedFrames() {
        return stableConvergedFrames;
    }

    /** Nanoseconds since AE first reported converged in this wait; 0 if not converged yet. */
    public long nsSinceFirstConverged() {
        long t = firstConvergedNs;
        return (t == 0L) ? 0L : System.nanoTime() - t;
    }

    /** Whether any repeating frame has reported AE convergence during the current wait. */
    public boolean hasSeenAeConvergence() {
        return firstConvergedNs != 0L;
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
     * When {@code true}: after AE converges, capture as soon as exposure is stable for
     * {@link #STABLE_FRAMES_REQUIRED} consecutive frames (capped at
     * {@link #EXPOSURE_STABILIZATION_DELAY_MS}). When {@code false}: request AE lock and wait for
     * {@link CaptureResult#CONTROL_AE_STATE_LOCKED} / {@link CaptureResult#CONTROL_AE_STATE_FLASH_REQUIRED}.
     */
    public static final boolean USE_IMMEDIATE_CAPTURE_ON_CONVERGENCE = true;

    /**
     * Upper bound on the post-convergence stability wait. The capture normally fires as soon as
     * {@link #STABLE_FRAMES_REQUIRED} consecutive converged frames report stable exposure
     * (typically ~3 frames ≈ 100ms); if exposure keeps oscillating, the capture is forced after
     * this many milliseconds — the same worst case as the historical fixed delay.
     */
    public static final int EXPOSURE_STABILIZATION_DELAY_MS = 475;

    /** Consecutive converged frames with stable exposure required before firing still capture. */
    public static final int STABLE_FRAMES_REQUIRED = 3;

    /** Max relative change in exposure×ISO between consecutive frames still counted as stable. */
    public static final double STABILITY_TOLERANCE = 0.05;

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
        /** AE converged with stable exposure (or stability wait capped) — capture immediately. */
        CAPTURE_NOW_STABLE,
        /** AE converged but exposure still settling — keep waiting for stability. */
        CONTINUE_WAITING_FOR_STABILITY,
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
            long elapsedNsSinceAeStart,
            int stableConvergedFrames,
            long nsSinceFirstConverged) {
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
                if (stableConvergedFrames >= STABLE_FRAMES_REQUIRED
                        || nsSinceFirstConverged
                                >= EXPOSURE_STABILIZATION_DELAY_MS * 1_000_000L) {
                    return AeRepeatCaptureDecision.CAPTURE_NOW_STABLE;
                }
                return AeRepeatCaptureDecision.CONTINUE_WAITING_FOR_STABILITY;
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
