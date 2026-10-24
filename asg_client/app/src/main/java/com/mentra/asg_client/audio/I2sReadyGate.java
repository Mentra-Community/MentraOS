package com.mentra.asg_client.audio;

import android.os.Handler;
import android.util.Log;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.audio.diag.AudioTraceBus;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicInteger;

/** Correlates playback with BES readiness without blocking the camera, main, or UART thread. */
public final class I2sReadyGate {
    private static final ConcurrentHashMap<Integer, I2sReadyGate> PENDING =
            new ConcurrentHashMap<>();
    private static final AtomicInteger NEXT_ID =
            new AtomicInteger(ThreadLocalRandom.current().nextInt(1, Integer.MAX_VALUE));
    private static final AtomicInteger LINK_EPOCH = new AtomicInteger();
    private static volatile boolean sSupported;

    private final Handler mHandler;
    private final List<Runnable[]> mWaiters = new ArrayList<>();
    private int mRequestId;
    private int mLinkEpoch;
    private Boolean mReady;
    private Runnable mTimeout;

    public I2sReadyGate(Handler handler) {
        mHandler = handler;
    }

    /** Advertised by the current UART session's sr_syvr.wire_caps.i2s_ready. */
    public static void setSupported(boolean supported) {
        sSupported = supported;
    }

    /** Invalidate readiness whenever the transport loses its proof of a live BES session. */
    public static void invalidateLink() {
        sSupported = false;
        onBridgeStopped();
    }

    /** A STOP from another audio owner also retires cached readiness. */
    public static void onBridgeStopped() {
        int epoch = LINK_EPOCH.incrementAndGet();
        AudioTraceBus.emit(AudioTraceBus.BRIDGE_INVALIDATED, "link_epoch", epoch);
        for (I2sReadyGate gate : PENDING.values()) {
            gate.failCurrentRequest();
        }
    }

    /** Called directly from the UART reader; callbacks always run on the supplied handler. */
    public static void onResponse(int requestId, boolean ready) {
        I2sReadyGate gate = PENDING.get(requestId);
        if (gate != null) {
            gate.complete(requestId, ready);
        }
    }

    /** Register before sending START so even an immediate reply cannot be lost. */
    public synchronized int begin() {
        cancel();
        mRequestId = NEXT_ID.updateAndGet(id -> id == Integer.MAX_VALUE ? 1 : id + 1);
        mLinkEpoch = LINK_EPOCH.get();
        mReady = null;
        int requestId = mRequestId;
        boolean requiresAck = sSupported;
        PENDING.put(requestId, this);
        AudioTraceBus.emit(
                AudioTraceBus.I2S_READY_BEGIN,
                "request_id",
                requestId,
                "requires_ack",
                requiresAck);
        mTimeout =
                () -> {
                    // Older BES builds have no readiness protocol. Keep a bounded compatibility
                    // delay;
                    // a firmware that advertises support must never turn a missing ACK into
                    // success.
                    boolean legacy = !requiresAck && !sSupported && mLinkEpoch == LINK_EPOCH.get();
                    Log.w(
                            "I2sReadyGate",
                            "[I2S-READY] id="
                                    + requestId
                                    + (legacy ? " legacy fallback" : " timeout"));
                    AudioTraceBus.emit(
                            AudioTraceBus.I2S_READY_TIMEOUT,
                            "request_id",
                            requestId,
                            "legacy",
                            legacy);
                    complete(requestId, legacy);
                };
        mHandler.postDelayed(
                mTimeout,
                requiresAck
                        ? AsgConstants.I2S_READY_TIMEOUT_MS
                        : AsgConstants.I2S_LEGACY_SETTLE_MS);
        return requestId;
    }

    /** True for a pending or ready request on this exact live link. */
    public synchronized boolean isUsable() {
        return mRequestId != 0 && !Boolean.FALSE.equals(mReady) && mLinkEpoch == LINK_EPOCH.get();
    }

    /** True once the current request has been answered ready; false while still pending. */
    public synchronized boolean isReady() {
        return Boolean.TRUE.equals(mReady);
    }

    /** The current request ID, or 0 when none is registered. */
    public synchronized int currentRequestId() {
        return mRequestId;
    }

    /** Register one prepared player; cancellation must still be checked by its owner. */
    public synchronized void whenReady(Runnable ready, Runnable failed) {
        if (mRequestId == 0 || mLinkEpoch != LINK_EPOCH.get()) {
            mHandler.post(failed);
        } else if (mReady == null) {
            mWaiters.add(new Runnable[] {ready, failed});
        } else {
            dispatch(mRequestId, ready, failed);
        }
    }

    /** Retire this request and all scheduled starts when playback is cancelled or closed. */
    public synchronized void cancel() {
        PENDING.remove(mRequestId, this);
        if (mTimeout != null) mHandler.removeCallbacks(mTimeout);
        mRequestId = 0;
        mReady = null;
        for (Runnable[] waiter : mWaiters) mHandler.post(waiter[1]);
        mWaiters.clear();
    }

    private synchronized void failCurrentRequest() {
        if (mLinkEpoch != LINK_EPOCH.get()) complete(mRequestId, false);
    }

    private synchronized void complete(int requestId, boolean ready) {
        if (requestId == 0 || requestId != mRequestId || mReady != null) return;
        ready = ready && mLinkEpoch == LINK_EPOCH.get();
        mReady = ready;
        PENDING.remove(requestId, this);
        mHandler.removeCallbacks(mTimeout);
        Log.i("I2sReadyGate", "[I2S-READY] id=" + requestId + " ready=" + ready);
        AudioTraceBus.emit(AudioTraceBus.I2S_READY, "request_id", requestId, "ready", ready);
        for (Runnable[] waiter : mWaiters) dispatch(requestId, waiter[0], waiter[1]);
        mWaiters.clear();
    }

    private void dispatch(int requestId, Runnable ready, Runnable failed) {
        mHandler.post(
                () -> {
                    boolean valid;
                    synchronized (I2sReadyGate.this) {
                        valid =
                                requestId == mRequestId
                                        && Boolean.TRUE.equals(mReady)
                                        && mLinkEpoch == LINK_EPOCH.get();
                    }
                    (valid ? ready : failed).run();
                });
    }
}
