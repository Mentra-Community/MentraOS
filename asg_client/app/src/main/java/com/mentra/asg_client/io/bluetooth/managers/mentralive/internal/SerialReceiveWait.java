package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructPollfd;
import android.util.Log;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.function.BooleanSupplier;

/**
 * Wait strategy for the UART receive loop. Historical K900 code slept 5ms/50ms after every
 * non-blocking read, adding up to that much latency before an ACK was noticed. Production uses
 * {@link PollWait} so the thread wakes when bytes are ready.
 */
public interface SerialReceiveWait {

    /** Block until serial data may be available or the wait is interrupted/timed out. */
    void await() throws InterruptedException;

    /** Legacy sleep-based poll used by older K900Server builds (kept for tests/docs). */
    final class SleepWait implements SerialReceiveWait {
        private final BooleanSupplier fastMode;
        private final long fastSleepMs;
        private final long normalSleepMs;

        public SleepWait(BooleanSupplier fastMode) {
            this(fastMode, 5L, 50L);
        }

        public SleepWait(BooleanSupplier fastMode, long fastSleepMs, long normalSleepMs) {
            this.fastMode = fastMode;
            this.fastSleepMs = fastSleepMs;
            this.normalSleepMs = normalSleepMs;
        }

        @Override
        public void await() throws InterruptedException {
            Thread.sleep(fastMode.getAsBoolean() ? fastSleepMs : normalSleepMs);
        }
    }

    /**
     * Block on {@link Os#poll} until the serial FD is readable. Uses a modest timeout so {@code
     * RecvThread} can observe stop flags even if interrupt delivery is delayed.
     */
    final class PollWait implements SerialReceiveWait {
        private static final String TAG = "SerialReceiveWait";
        private static final int POLL_TIMEOUT_MS = 1000;

        private final StructPollfd[] pollFds;

        public PollWait(FileDescriptor fd) {
            StructPollfd pollFd = new StructPollfd();
            pollFd.fd = fd;
            pollFd.events = (short) OsConstants.POLLIN;
            this.pollFds = new StructPollfd[] {pollFd};
        }

        @Override
        public void await() throws InterruptedException {
            if (Thread.interrupted()) {
                throw new InterruptedException();
            }
            try {
                Os.poll(pollFds, POLL_TIMEOUT_MS);
            } catch (ErrnoException e) {
                if (e.errno == OsConstants.EINTR) {
                    throw new InterruptedException();
                }
                Log.w(TAG, "Os.poll failed; falling back to short sleep", e);
                Thread.sleep(5);
            }
        }
    }

    /**
     * Build the best available wait for a serial input stream. Falls back to {@link SleepWait} when
     * the FD cannot be obtained (unit tests / unexpected stream types).
     */
    static SerialReceiveWait forInputStream(InputStream inputStream, BooleanSupplier fastMode) {
        if (inputStream instanceof FileInputStream) {
            try {
                FileDescriptor fd = ((FileInputStream) inputStream).getFD();
                if (fd != null && fd.valid()) {
                    return new PollWait(fd);
                }
            } catch (Exception e) {
                Log.w("SerialReceiveWait", "Unable to obtain serial FD for poll; using sleep", e);
            }
        }
        return new SleepWait(fastMode);
    }
}
