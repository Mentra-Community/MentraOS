package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

import com.mentra.asg_client.service.core.AsgClientService;
import com.mentra.asg_client.service.core.processors.CommandProcessor;

/**
 * Debug receiver for polling BES trace logs into MentraBleTrace.
 *
 * Usage:
 *   adb shell am broadcast -a com.mentra.DEBUG_BES_TRACE --ez enabled true --ei interval_ms 5000
 *   adb shell am broadcast -a com.mentra.DEBUG_BES_TRACE --ez enabled false
 */
public class DebugBesTraceReceiver extends BroadcastReceiver {
    private static final String TAG = "DebugBesTraceReceiver";
    public static final String ACTION_DEBUG_BES_TRACE = "com.mentra.DEBUG_BES_TRACE";
    private static final long DEFAULT_INTERVAL_MS = 5000;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_DEBUG_BES_TRACE.equals(intent.getAction())) {
            return;
        }

        boolean enabled = intent.getBooleanExtra("enabled", true);
        long intervalMs = readIntervalMs(intent);

        AsgClientService service = AsgClientService.getInstance();
        if (service == null) {
            Log.e(TAG, "AsgClientService not running - cannot toggle BES trace polling");
            return;
        }

        CommandProcessor processor = service.getCommandProcessor();
        if (processor == null) {
            Log.e(TAG, "CommandProcessor not ready - cannot toggle BES trace polling");
            return;
        }

        processor.setBesTracePollingEnabled(enabled, intervalMs);
        Log.i(TAG, "BES trace polling " + (enabled ? "enabled" : "disabled")
            + " intervalMs=" + intervalMs);
    }

    private long readIntervalMs(Intent intent) {
        Bundle extras = intent.getExtras();
        if (extras == null || !extras.containsKey("interval_ms")) {
            return DEFAULT_INTERVAL_MS;
        }
        Object value = extras.get("interval_ms");
        if (value instanceof Number) {
            return ((Number) value).longValue();
        }
        return DEFAULT_INTERVAL_MS;
    }
}
