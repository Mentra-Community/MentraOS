package com.mentra.asg_client.io.media.core;

/**
 * Single-slot camera-holding capture occupancy. Each successful {@link #begin} mints a unique,
 * monotonically increasing token; {@link #end} only clears the slot when it is handed that exact
 * token. Compare-and-set on the token (not the request id) so a late {@link #end} from a finished
 * capture cannot free a newer one even when the newer capture reuses the same request id.
 *
 * <p>No Android imports: modeled on {@link VideoRecordingLifecycle}.
 */
final class CaptureBusyTracker {

    /** Sentinel returned by {@link #begin} on rejection and rejected by {@link #end}. */
    static final long NO_CAPTURE = 0L;

    private String activeRequestId;
    private long activeToken = NO_CAPTURE;
    private long lastToken = NO_CAPTURE;

    /**
     * @return a positive token owning the slot, or {@link #NO_CAPTURE} if the slot is occupied or
     *     the request id is unusable.
     */
    synchronized long begin(String requestId) {
        if (!isUsableRequestId(requestId) || activeRequestId != null) {
            return NO_CAPTURE;
        }
        activeRequestId = requestId;
        activeToken = ++lastToken;
        return activeToken;
    }

    /** Clears the slot only if {@code token} still owns it. */
    synchronized boolean end(long token) {
        if (token == NO_CAPTURE || token != activeToken) {
            return false;
        }
        activeRequestId = null;
        activeToken = NO_CAPTURE;
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
