package com.mentra.asg_client.io.media.core;

import java.util.Objects;

/**
 * Camera-holding capture occupancy plus a safety timeout. {@link #begin} arms the watchdog and
 * returns a unique token; {@link #end} cancels that token's watchdog and clears occupancy; expiry
 * force-clears the tracker so a missed terminal cannot lock the button permanently.
 *
 * <p>The watchdog is keyed by the per-capture token rather than the request id, so a late terminal
 * {@link #end} for a finished capture cannot cancel the safety timer or clear the busy flag of a
 * newer capture that reused the same request id.
 */
final class CaptureBusyGate {

    static final String CAPTURE_KEY_PREFIX = "capture:";

    /** Returned by {@link #begin} when the slot is already occupied; rejected by {@link #end}. */
    static final long NO_CAPTURE = CaptureBusyTracker.NO_CAPTURE;

    private final CaptureBusyTracker tracker;
    private final CaptureWatchdog watchdog;
    private final long timeoutMs;

    CaptureBusyGate(CaptureBusyTracker tracker, CaptureWatchdog watchdog, long timeoutMs) {
        this.tracker = Objects.requireNonNull(tracker, "tracker");
        this.watchdog = Objects.requireNonNull(watchdog, "watchdog");
        if (timeoutMs <= 0) {
            throw new IllegalArgumentException("timeoutMs must be positive");
        }
        this.timeoutMs = timeoutMs;
    }

    /**
     * @return a positive token that must be passed to {@link #end}, or {@link #NO_CAPTURE} if
     *     another capture is already in flight.
     */
    long begin(String requestId) {
        long token = tracker.begin(requestId);
        if (token == NO_CAPTURE) {
            return NO_CAPTURE;
        }
        watchdog.arm(captureKey(token), timeoutMs, () -> tracker.end(token));
        return token;
    }

    boolean end(long token) {
        if (token == NO_CAPTURE) {
            return false;
        }
        watchdog.cancel(captureKey(token));
        return tracker.end(token);
    }

    boolean isBusy() {
        return tracker.isBusy();
    }

    String activeRequestId() {
        return tracker.activeRequestId();
    }

    static String captureKey(long token) {
        return CAPTURE_KEY_PREFIX + token;
    }
}
