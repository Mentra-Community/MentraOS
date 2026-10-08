package com.mentra.asg_client.io.bluetooth.managers.mentralive.internal;

import android.os.Handler;
import android.os.SystemClock;

import com.mentra.asg_client.AsgConstants;

import java.util.function.Consumer;
import java.util.function.LongSupplier;

/** One bounded fixed-switch request, correlated with the UART descriptor that wrote it. */
public final class UnwornAutoPowerOffRequest {
    /** Terminal result; only a matching BES acknowledgment can produce {@code disabled}. */
    public static final class Result {
        public final String status;
        public final int resultCode;

        private Result(String status, int resultCode) {
            this.status = status;
            this.resultCode = resultCode;
        }
    }

    /** No live normal UART path was available, so no switch command was attempted. */
    public static Result unavailable() {
        return new Result("transport_unavailable", -1);
    }

    /** Opaque identity for the sole admitted request and its queued UART worker. */
    public static final class Token {
        private final Object session;
        private final long deadline;
        private final Consumer<Result> callback;
        private Runnable timeout;
        private boolean attempted;
        private boolean writeComplete;
        private boolean workerDone;
        private boolean finished;
        private Integer replyCode;

        private Token(Object session, long deadline, Consumer<Result> callback) {
            this.session = session;
            this.deadline = deadline;
            this.callback = callback;
        }
    }

    private final Handler mHandler;
    private final LongSupplier mClock;
    private Token mPending;
    private Object mAmbiguousSession;

    /** Use the service handler for bounded timeouts and callbacks outside transport locks. */
    public UnwornAutoPowerOffRequest(Handler handler) {
        this(handler, SystemClock::elapsedRealtime);
    }

    UnwornAutoPowerOffRequest(Handler handler, LongSupplier clock) {
        mHandler = handler;
        mClock = clock;
    }

    /** Register before queuing. A timed-out worker retains the only slot until it drains. */
    public synchronized Token begin(Object session, Consumer<Result> callback) {
        if (mPending != null) {
            deliver(callback, "busy", -1);
            return null;
        }
        if (session == mAmbiguousSession) {
            deliver(callback, "session_changed", -1);
            return null;
        }
        Token token =
                new Token(
                        session,
                        mClock.getAsLong() + AsgConstants.UNWORN_AUTO_POWER_OFF_TIMEOUT_MS,
                        callback);
        mPending = token;
        token.timeout = () -> fail(token, "timeout");
        mHandler.postDelayed(token.timeout, AsgConstants.UNWORN_AUTO_POWER_OFF_TIMEOUT_MS);
        return token;
    }

    /** Last check on the UART I/O lane, immediately before the synchronous write attempt. */
    public synchronized boolean beginWrite(Token token) {
        if (!live(token)) return false;
        token.attempted = true;
        return true;
    }

    /** Queue/send failure and timeout never become success, even when a late ACK arrives. */
    public synchronized void writeComplete(Token token, boolean sent) {
        if (token != mPending) return;
        token.workerDone = true;
        if (token.finished) {
            mPending = null;
            return;
        }
        if (!live(token)) return;
        if (!sent) {
            finish(token, "send_failed", -1);
        } else {
            token.writeComplete = true;
            completeReply(token);
        }
    }

    /** A current-session ACK may arrive before the synchronous write returns. */
    public synchronized void reply(Object session, int resultCode, int type, int value) {
        Token token = mPending;
        if (token == null
                || token.session != session
                || !token.attempted
                || !live(token)
                || type != AsgConstants.UNWORN_AUTO_POWER_OFF_SWITCH_TYPE
                || value != 0) return;
        if (token.replyCode != null) return;
        token.replyCode = resultCode;
        completeReply(token);
    }

    /** Fail only this request; ambiguous attempts prevent reuse of that UART session. */
    public synchronized void fail(Token token, String status) {
        if (token == mPending && !token.finished) finish(token, status, -1);
    }

    /** Service shutdown cannot leave a successful-looking pending command. */
    public synchronized void close() {
        if (mPending != null && !mPending.finished) finish(mPending, "session_changed", -1);
    }

    private boolean live(Token token) {
        if (token != mPending || token.finished) return false;
        if (mClock.getAsLong() >= token.deadline) {
            finish(token, "timeout", -1);
            return false;
        }
        return true;
    }

    private void completeReply(Token token) {
        if (token.writeComplete && token.replyCode != null) {
            finish(token, token.replyCode == 0 ? "disabled" : "rejected", token.replyCode);
        }
    }

    private void finish(Token token, String status, int resultCode) {
        token.finished = true;
        mHandler.removeCallbacks(token.timeout);
        // BES has no request_id in sr_swit. A late reply must not satisfy a same-link retry.
        if (token.attempted && resultCode == -1) mAmbiguousSession = token.session;
        if (token.workerDone) mPending = null;
        deliver(token.callback, status, resultCode);
    }

    private void deliver(Consumer<Result> callback, String status, int resultCode) {
        // Never run caller/phone response code under the request or UART coordinator lock.
        mHandler.post(() -> callback.accept(new Result(status, resultCode)));
    }
}
