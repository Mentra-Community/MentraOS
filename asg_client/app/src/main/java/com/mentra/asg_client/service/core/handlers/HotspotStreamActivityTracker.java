package com.mentra.asg_client.service.core.handlers;

import android.os.Handler;
import android.util.Log;

import com.mentra.asg_client.AsgConstants;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;

/**
 * Keeps the hotspot idle clock aligned with the lifecycle of a hotspot-local stream.
 *
 * Mentra Call WHIP does not send {@code keep_stream_alive}. Without a local tick the
 * glasses treat the AP as idle after {@link AsgConstants#HOTSPOT_INACTIVITY_TIMEOUT_MS}
 * and auto-disable it mid-call.
 */
final class HotspotStreamActivityTracker {
    private static final String TAG = "HotspotStreamActivity";

    /** Well under the 120s idle cutoff so one missed BLE keep-alive cannot kill a live call. */
    static final long LOCAL_STREAM_REFRESH_MS = 30_000L;

    private final INetworkManager mNetworkManager;
    private final Handler mHandler;
    private final Runnable mRefreshLoop = this::refreshAndReschedule;
    private volatile boolean mUsesLocalHotspotRoute;

    HotspotStreamActivityTracker(INetworkManager networkManager) {
        this(networkManager, null);
    }

    HotspotStreamActivityTracker(INetworkManager networkManager, Handler handler) {
        mNetworkManager = networkManager;
        mHandler = handler;
    }

    void onStreamStarted(boolean usesLocalHotspotRoute) {
        mUsesLocalHotspotRoute = usesLocalHotspotRoute;
        refreshHotspotActivity();
        reschedule();
    }

    void onKeepAlive() {
        refreshHotspotActivity();
        reschedule();
    }

    void onSessionActive() {
        refreshHotspotActivity();
    }

    void onStreamStopped() {
        mUsesLocalHotspotRoute = false;
        if (mHandler != null) {
            mHandler.removeCallbacks(mRefreshLoop);
        }
    }

    private void refreshAndReschedule() {
        refreshHotspotActivity();
        reschedule();
    }

    private void reschedule() {
        if (mHandler == null) {
            return;
        }
        mHandler.removeCallbacks(mRefreshLoop);
        if (mUsesLocalHotspotRoute) {
            mHandler.postDelayed(mRefreshLoop, LOCAL_STREAM_REFRESH_MS);
        }
    }

    private void refreshHotspotActivity() {
        if (!mUsesLocalHotspotRoute || mNetworkManager == null) {
            return;
        }
        try {
            if (mNetworkManager.isHotspotEnabled()) {
                mNetworkManager.updateHttpActivity();
            }
        } catch (RuntimeException e) {
            // Hotspot bookkeeping must never fail an otherwise valid stream command.
            Log.w(TAG, "Could not refresh hotspot activity for local stream", e);
        }
    }
}
