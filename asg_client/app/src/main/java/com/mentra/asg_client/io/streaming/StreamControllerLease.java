package com.mentra.asg_client.io.streaming;

import java.util.function.Supplier;

/** Fresh native challenge responses prove app execution; BLE presence alone cannot. */
public final class StreamControllerLease {
    private final long mTimeoutMs;
    private final Supplier<String> mNonce;
    private String mProbeId;
    private long mDeadlineMs;

    /** Call exclusively on the stream lifecycle owner with a monotonic clock. */
    public StreamControllerLease(long timeoutMs, Supplier<String> nonce) {
        mTimeoutMs = timeoutMs;
        mNonce = nonce;
    }

    /** Starts a new challenge, invalidating responses from any previous stream. */
    public void start(long nowMs) {
        mProbeId = mNonce.get();
        mDeadlineMs = nowMs + mTimeoutMs;
    }

    /** Each accepted response rotates the challenge so duplicates cannot extend the lease. */
    public boolean acknowledge(String probeId, long nowMs) {
        if (mProbeId == null || !mProbeId.equals(probeId) || expired(nowMs)) return false;
        start(nowMs);
        return true;
    }

    /** Returns the outstanding challenge to retransmit without extending its deadline. */
    public String probeId() { return mProbeId; }

    /** Returns whether the active challenge's response deadline has elapsed. */
    public boolean expired(long nowMs) { return mProbeId != null && nowMs >= mDeadlineMs; }

    /** Schedule the final check at the deadline, not a later retransmission interval. */
    public long remainingMs(long nowMs) { return Math.max(0, mDeadlineMs - nowMs); }

    /** Invalidates all responses and stops enforcement after stream teardown. */
    public void stop() { mProbeId = null; }
}
