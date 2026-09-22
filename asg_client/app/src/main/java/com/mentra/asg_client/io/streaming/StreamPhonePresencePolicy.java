package com.mentra.asg_client.io.streaming;

/**
 * Decides when a stream must stop after losing its controlling phone.
 *
 * <p>All calls belong to the streaming lifecycle's serialized dispatcher. Time is monotonic and
 * supplied by the caller. UART availability and stream keep-alives are deliberately not inputs.
 * A generation token prevents a delayed deadline from stopping a replacement stream, even when
 * the caller reuses the same public stream id.
 */
public final class StreamPhonePresencePolicy {
    /** BES phone notification-subscription presence, independent of the MTK UART connection. */
    public enum Presence {
        PRESENT,
        ABSENT,
        UNKNOWN
    }

    private final long mDisconnectGraceMs;
    private Presence mPresence = Presence.UNKNOWN;
    private long mGeneration;
    private boolean mActive;
    private long mLossDeadlineMs = -1;

    /** Creates a policy with a strictly positive phone-disconnect grace. */
    public StreamPhonePresencePolicy(long disconnectGraceMs) {
        if (disconnectGraceMs <= 0) {
            throw new IllegalArgumentException("disconnectGraceMs must be positive");
        }
        mDisconnectGraceMs = disconnectGraceMs;
    }

    /**
     * Starts a new stream generation. Unknown presence cannot safely authorize indefinite capture;
     * the command handler must report that the phone presence signal is unavailable.
     */
    public long start() {
        if (mPresence != Presence.PRESENT) {
            throw new IllegalStateException("Streaming requires confirmed phone BLE presence");
        }
        mGeneration++;
        mActive = true;
        mLossDeadlineMs = -1;
        return mGeneration;
    }

    /** Updates presence without extending an already-running disconnect grace. */
    public void onPresence(Presence presence, long nowMs) {
        if (presence == null) {
            throw new IllegalArgumentException("presence is required");
        }
        mPresence = presence;
        if (presence == Presence.PRESENT) {
            mLossDeadlineMs = -1;
        } else if (mActive && mLossDeadlineMs < 0) {
            mLossDeadlineMs = nowMs + mDisconnectGraceMs;
        }
    }

    /** Returns whether the current authoritative signal allows starting a stream. */
    public boolean canStart() {
        return mPresence == Presence.PRESENT;
    }

    /** Returns the monotonic stop deadline, or -1 when no deadline is pending. */
    public long getLossDeadlineMs() {
        return mLossDeadlineMs;
    }

    /** Returns the active stream's generation for tagging scheduled work. */
    public long getGeneration() {
        return mGeneration;
    }

    /** Claims a due stop exactly once; stale generations and early timers are harmless. */
    public boolean claimExpiredStop(long generation, long nowMs) {
        if (!mActive || generation != mGeneration || mLossDeadlineMs < 0
                || nowMs < mLossDeadlineMs) {
            return false;
        }
        mActive = false;
        mLossDeadlineMs = -1;
        return true;
    }

    /** Releases ownership on explicit stop, terminal publisher failure, or service teardown. */
    public void stop() {
        mActive = false;
        mLossDeadlineMs = -1;
    }
}
