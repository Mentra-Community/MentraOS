package com.mentra.asg_client.service.core.handlers;

import android.util.Log;

import com.mentra.asg_client.io.network.interfaces.INetworkManager;

/** Keeps the hotspot idle clock aligned with the lifecycle of a hotspot-local stream. */
final class HotspotStreamActivityTracker {
    private static final String TAG = "HotspotStreamActivity";

    private final INetworkManager mNetworkManager;
    private volatile boolean mUsesLocalHotspotRoute;

    HotspotStreamActivityTracker(INetworkManager networkManager) {
        mNetworkManager = networkManager;
    }

    void onStreamStarted(boolean usesLocalHotspotRoute) {
        mUsesLocalHotspotRoute = usesLocalHotspotRoute;
        refreshHotspotActivity();
    }

    void onKeepAlive() {
        refreshHotspotActivity();
    }

    void onStreamStopped() {
        mUsesLocalHotspotRoute = false;
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
