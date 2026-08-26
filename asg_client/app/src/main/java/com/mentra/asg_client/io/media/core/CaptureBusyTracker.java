package com.mentra.asg_client.io.media.core;

/**
 * Single-slot camera-holding capture occupancy. Compare-and-set so a late {@link #end} from a
 * finished capture cannot free a newer one.
 *
 * <p>No Android imports: modeled on {@link VideoRecordingLifecycle}.
 */
final class CaptureBusyTracker {

    private String activeRequestId;

    synchronized boolean begin(String requestId) {
        if (!isUsableRequestId(requestId) || activeRequestId != null) {
            return false;
        }
        activeRequestId = requestId;
        return true;
    }

    synchronized boolean end(String requestId) {
        if (!isUsableRequestId(requestId) || !requestId.equals(activeRequestId)) {
            return false;
        }
        activeRequestId = null;
        return true;
    }

    synchronized boolean isBusy() {
        return activeRequestId != null;
    }

    synchronized String activeRequestId() {
        return activeRequestId;
    }

    private static boolean isUsableRequestId(String requestId) {
        return requestId != null && !requestId.isEmpty();
    }
}
