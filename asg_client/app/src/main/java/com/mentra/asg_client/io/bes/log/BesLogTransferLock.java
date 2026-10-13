package com.mentra.asg_client.io.bes.log;

import androidx.annotation.VisibleForTesting;

import com.mentra.asg_client.AsgConstants;

import java.util.ArrayDeque;
import java.util.function.LongSupplier;

/**
 * Serializes the transfers that share the BES log channel: a user's {@code mh_logs}, the crash
 * dump pull ({@code cs_log}) and one TRACE tail read window. The BES suspends its TRACE frames while
 * a {@code cs_log} dump is sent, and {@code sr_log} packets carry no transfer id, so two transfers
 * at once would interleave into each other's sessions.
 *
 * <p>Waiters are served in arrival order, so a bug report that waits behind a crash pull is not
 * overtaken by the periodic TRACE poll. The lock is not reentrant: acquiring it again as the
 * current owner returns true and a single {@link #release} frees it. A holder that never releases
 * loses the lock after {@link AsgConstants#BES_LOG_LOCK_MAX_HOLD_MS} so the channel cannot wedge.
 */
public final class BesLogTransferLock {
    public enum Owner {
        USER_MH_LOGS,
        CRASH_CS_LOG,
        TRACE_TAIL
    }

    private static final BesLogTransferLock INSTANCE = new BesLogTransferLock();

    private final Object mMonitor = new Object();
    private final LongSupplier mClockMs;
    private final long mMaxHoldMs;
    private final ArrayDeque<Object> mWaiters = new ArrayDeque<>();
    private Owner mOwner;
    private long mAcquiredAtMs;

    public static BesLogTransferLock get() {
        return INSTANCE;
    }

    private BesLogTransferLock() {
        this(System::currentTimeMillis, AsgConstants.BES_LOG_LOCK_MAX_HOLD_MS);
    }

    @VisibleForTesting
    public BesLogTransferLock(LongSupplier clockMs, long maxHoldMs) {
        mClockMs = clockMs;
        mMaxHoldMs = maxHoldMs;
    }

    /**
     * Waits up to {@code timeoutMs} for the channel (0 means one try without waiting).
     *
     * @return true when {@code owner} now holds the lock
     */
    public boolean acquire(Owner owner, long timeoutMs) throws InterruptedException {
        if (owner == null) {
            throw new IllegalArgumentException("owner");
        }
        synchronized (mMonitor) {
            if (mOwner == owner) {
                return true;
            }
            if (tryTakeLocked(owner, true)) {
                return true;
            }
            if (timeoutMs <= 0) {
                return false;
            }
            Object ticket = new Object();
            mWaiters.addLast(ticket);
            long deadline = System.nanoTime() + timeoutMs * 1_000_000L;
            try {
                while (true) {
                    if (mWaiters.peekFirst() == ticket && tryTakeLocked(owner, false)) {
                        return true;
                    }
                    long remainingNs = deadline - System.nanoTime();
                    if (remainingNs <= 0) {
                        return false;
                    }
                    long waitMs = remainingNs / 1_000_000L;
                    // Wake up in time to notice a holder that overstayed its maximum hold.
                    if (mOwner != null) {
                        long stealInMs = mAcquiredAtMs + mMaxHoldMs - mClockMs.getAsLong();
                        waitMs = Math.min(waitMs, Math.max(1, stealInMs));
                    }
                    mMonitor.wait(Math.max(1, waitMs));
                }
            } finally {
                boolean wasFirst = mWaiters.peekFirst() == ticket;
                mWaiters.remove(ticket);
                if (wasFirst) {
                    mMonitor.notifyAll();
                }
            }
        }
    }

    /** Frees the lock; a call by anyone but the current owner changes nothing. */
    public void release(Owner owner) {
        synchronized (mMonitor) {
            if (mOwner != owner) {
                return;
            }
            mOwner = null;
            mMonitor.notifyAll();
        }
    }

    /** The current owner, or null when the channel is free. */
    public Owner current() {
        synchronized (mMonitor) {
            expireLocked();
            return mOwner;
        }
    }

    @VisibleForTesting
    public void resetForTest() {
        synchronized (mMonitor) {
            mOwner = null;
            mWaiters.clear();
            mMonitor.notifyAll();
        }
    }

    private boolean tryTakeLocked(Owner owner, boolean mustHaveNoWaiters) {
        expireLocked();
        if (mOwner != null) {
            return false;
        }
        if (mustHaveNoWaiters && !mWaiters.isEmpty()) {
            return false;
        }
        mOwner = owner;
        mAcquiredAtMs = mClockMs.getAsLong();
        return true;
    }

    private void expireLocked() {
        if (mOwner != null && mClockMs.getAsLong() - mAcquiredAtMs >= mMaxHoldMs) {
            mOwner = null;
            mMonitor.notifyAll();
        }
    }
}
