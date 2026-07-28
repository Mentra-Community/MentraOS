package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import com.mentra.asg_client.io.network.core.NetworkManagerFactory;
import com.mentra.asg_client.io.network.interfaces.INetworkManager;

/**
 * Debug receiver for driving the glasses hotspot via adb, for bench work on hotspot-served OTA
 * (OS-1676) and gallery-sync debugging.
 *
 * <p>Usage: adb shell am broadcast -a com.mentra.DEBUG_HOTSPOT --ez enabled true \ -n
 * com.mentra.asg_client/.receiver.DebugHotspotReceiver
 *
 * <p>Pass {@code --ez enabled false} to stop. Credentials are platform-generated on every start;
 * watch logcat tag DebugHotspotReceiver for SSID/password/gateway once the AP is up.
 *
 * <p>The receiver owns a private network-manager instance and pings {@link
 * INetworkManager#updateHttpActivity()} on a keep-alive thread so the idle monitor does not stop
 * the hotspot between manual test steps. FOR DEVELOPMENT/TESTING ONLY.
 */
public class DebugHotspotReceiver extends BroadcastReceiver {
    private static final String TAG = "DebugHotspotReceiver";
    public static final String ACTION_DEBUG_HOTSPOT = "com.mentra.DEBUG_HOTSPOT";

    private static final long KEEPALIVE_INTERVAL_MS = 15_000;

    private static INetworkManager sManager;
    private static Thread sKeepAlive;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_DEBUG_HOTSPOT.equals(intent.getAction())) {
            return;
        }

        boolean enabled = intent.getBooleanExtra("enabled", true);
        Log.w(TAG, "========================================");
        Log.w(TAG, "⚠️ DEBUG HOTSPOT " + (enabled ? "START" : "STOP") + " VIA ADB ⚠️");
        Log.w(TAG, "========================================");

        synchronized (DebugHotspotReceiver.class) {
            if (enabled) {
                start(context);
            } else {
                stop();
            }
        }
    }

    private static void start(Context context) {
        if (sManager != null) {
            Log.w(TAG, "Debug hotspot already running - current state below");
            logState(sManager);
            return;
        }

        INetworkManager manager = NetworkManagerFactory.getNetworkManager(context);
        sManager = manager;
        manager.startHotspot();
        Log.i(TAG, "🚀 Hotspot start requested - waiting for AP to come up");

        sKeepAlive =
                new Thread(
                        () -> {
                            while (!Thread.currentThread().isInterrupted()) {
                                try {
                                    Thread.sleep(KEEPALIVE_INTERVAL_MS);
                                } catch (InterruptedException e) {
                                    return;
                                }
                                manager.updateHttpActivity();
                                logState(manager);
                            }
                        },
                        "DebugHotspotKeepAlive");
        sKeepAlive.setDaemon(true);
        sKeepAlive.start();
    }

    private static void stop() {
        if (sManager == null) {
            Log.w(TAG, "Debug hotspot not running - nothing to stop");
            return;
        }
        if (sKeepAlive != null) {
            sKeepAlive.interrupt();
            sKeepAlive = null;
        }
        try {
            sManager.stopHotspot();
            sManager.shutdown();
        } finally {
            sManager = null;
        }
        Log.i(TAG, "✅ Hotspot stopped");
    }

    private static void logState(INetworkManager manager) {
        Log.i(
                TAG,
                "hotspot enabled="
                        + manager.isHotspotEnabled()
                        + " ssid="
                        + manager.getHotspotSsid()
                        + " password="
                        + manager.getHotspotPassword()
                        + " gatewayIp="
                        + manager.getHotspotGatewayIp());
    }
}
