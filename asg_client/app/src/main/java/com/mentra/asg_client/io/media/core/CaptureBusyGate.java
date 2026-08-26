package com.mentra.asg_client.io.media.core;

import java.util.Objects;

/**
 * Camera-holding capture occupancy plus a safety timeout. {@link #begin} arms the watchdog; {@link
 * #end} cancels it; expiry force-clears the tracker so a missed terminal cannot lock the button
 * permanently.
 */
final class CaptureBusyGate {

    static final String CAPTURE_KEY_PREFIX = "capture:";

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

    boolean begin(String requestId) {
        if (!tracker.begin(requestId)) {
            return false;
        }
        watchdog.arm(captureKey(requestId), timeoutMs, () -> tracker.end(requestId));
        return true;
    }

    boolean end(String requestId) {
        watchdog.cancel(captureKey(requestId));
        return tracker.end(requestId);
    }

    boolean isBusy() {
        return tracker.isBusy();
    }

    String activeRequestId() {
        return tracker.activeRequestId();
    }

    static String captureKey(String requestId) {
        return CAPTURE_KEY_PREFIX + requestId;
    }
}
