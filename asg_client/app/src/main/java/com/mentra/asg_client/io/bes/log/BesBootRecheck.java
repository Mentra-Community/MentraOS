package com.mentra.asg_client.io.bes.log;

import android.util.Log;

import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Re-reads the BES {@code sr_syvr} when ASG learns the BES booted again without a link loss.
 *
 * <p>A BES-only reset (hardware watchdog, assert) leaves the MTK up, so nothing would ask the BES
 * for its identity again and {@link BesCrashDumpCollector#onSystemVersion} would never see the new
 * {@code boot_id} or reset codes. The signals are the TRACE tail seeing a new {@code bid} and
 * {@link BesLivenessMonitor}'s reboot detection. Both may fire several times for one boot, so
 * triggers inside {@link #DEBOUNCE_MS} collapse into one request; a request the UART lane refuses
 * (another operation owns it) is retried a few times.
 */
public final class BesBootRecheck {
    private static final String TAG = "BesBootRecheck";

    static final long DEBOUNCE_MS = 1_500;
    static final long RETRY_MS = 2_000;
    static final int MAX_ATTEMPTS = 8;

    /** Asks the BES for sr_syvr; false when the request was refused right now. */
    public interface Requester {
        boolean requestSystemVersion();
    }

    /** Cancels a delayed task. */
    public interface Cancellable {
        void cancel();
    }

    /** Single-threaded delayed executor (a manual fake in tests). */
    public interface Scheduler {
        Cancellable postDelayed(Runnable task, long delayMs);
    }

    private final Requester mRequester;
    private final Scheduler mScheduler;
    private final Object mLock = new Object();
    private Cancellable mPending;
    private int mAttempts;

    public BesBootRecheck(Requester requester, Scheduler scheduler) {
        mRequester = requester;
        mScheduler = scheduler;
    }

    /** Production instance on its own daemon thread. */
    public static BesBootRecheck create(Requester requester) {
        ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(1, runnable -> {
            Thread thread = new Thread(runnable, "bes-boot-recheck");
            thread.setDaemon(true);
            return thread;
        });
        executor.setRemoveOnCancelPolicy(true);
        return new BesBootRecheck(requester, (task, delayMs) -> {
            ScheduledFuture<?> future = executor.schedule(task, delayMs, TimeUnit.MILLISECONDS);
            return () -> future.cancel(false);
        });
    }

    /** The BES booted again (a new bid, or a confirmed reboot). Safe from any thread. */
    public void onBootChange(String reason) {
        synchronized (mLock) {
            if (mPending != null) {
                return; // A request is already scheduled; it will carry this boot too.
            }
            mAttempts = 0;
            Log.i(TAG, "BES booted again (" + reason + "); re-reading sr_syvr");
            schedule(DEBOUNCE_MS);
        }
    }

    private void schedule(long delayMs) {
        mPending = mScheduler.postDelayed(this::run, delayMs);
    }

    private void run() {
        synchronized (mLock) {
            mPending = null;
            boolean sent;
            try {
                sent = mRequester.requestSystemVersion();
            } catch (RuntimeException e) {
                Log.w(TAG, "sr_syvr request failed", e);
                sent = false;
            }
            if (!sent && ++mAttempts < MAX_ATTEMPTS) {
                schedule(RETRY_MS);
            }
        }
    }
}
