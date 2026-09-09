package com.mentra.asg_client.io.media.core;

/**
 * Serializes video recording starts with asynchronous recorder teardown.
 *
 * <p>The camera remains occupied after a stop request is dispatched, until MediaRecorder finishes
 * finalizing the file and the terminal callback runs. One start received during that interval is
 * retained and released only after termination; additional starts are rejected.
 */
final class VideoRecordingLifecycle {
    enum StartResult {
        START_NOW,
        QUEUED,
        REJECTED
    }

    private enum Phase {
        IDLE,
        STARTING,
        RECORDING,
        STOPPING
    }

    private Phase phase = Phase.IDLE;
    private Runnable pendingStart;

    synchronized StartResult requestStart(Runnable startAction) {
        if (phase == Phase.IDLE) {
            phase = Phase.STARTING;
            return StartResult.START_NOW;
        }
        if (phase == Phase.STOPPING && pendingStart == null) {
            pendingStart = startAction;
            return StartResult.QUEUED;
        }
        return StartResult.REJECTED;
    }

    synchronized void recordingStarted() {
        if (phase == Phase.STARTING) {
            phase = Phase.RECORDING;
        }
    }

    synchronized boolean beginStop() {
        if (phase != Phase.RECORDING) {
            return false;
        }
        phase = Phase.STOPPING;
        return true;
    }

    /**
     * Completes the active lifecycle and returns the queued start, if any.
     *
     * <p>When a start is returned, the phase is already STARTING so no later request can overtake
     * it before its posted action runs.
     */
    synchronized Runnable recordingTerminated() {
        Runnable next = pendingStart;
        pendingStart = null;
        phase = next == null ? Phase.IDLE : Phase.STARTING;
        return next;
    }

    synchronized void startFailed() {
        if (phase == Phase.STARTING) {
            phase = Phase.IDLE;
        }
    }

    synchronized boolean isStopping() {
        return phase == Phase.STOPPING;
    }

    synchronized void cancelPendingStart() {
        pendingStart = null;
    }
}
