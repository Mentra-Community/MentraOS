package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.asg_client.io.ota.helpers.OtaHelper;

/**
 * Debug receiver for testing MentraOS OTA: version check, download, checksum verify.
 * Does NOT install - safe for automated testing.
 *
 * Usage:
 *   adb shell am broadcast -a com.mentra.DEBUG_OTA_CHECK -n com.mentra.asg_client/.receiver.DebugOtaReceiver
 *
 * Requires: WiFi connected, AsgClientService running.
 * Monitor: adb logcat -s OtaHelper OtaConstants
 *
 * FOR DEVELOPMENT/TESTING ONLY.
 */
public class DebugOtaReceiver extends BroadcastReceiver {
    private static final String TAG = "DebugOtaReceiver";
    public static final String ACTION_DEBUG_OTA_CHECK = "com.mentra.DEBUG_OTA_CHECK";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_DEBUG_OTA_CHECK.equals(intent.getAction())) {
            return;
        }

        Log.w(TAG, "========================================");
        Log.w(TAG, "⚠️ DEBUG OTA CHECK (prefetch only, no install) ⚠️");
        Log.w(TAG, "========================================");

        OtaHelper helper = OtaHelper.getInstance();
        if (helper == null) {
            Log.e(TAG, "❌ OtaHelper not initialized - is OtaService running?");
            return;
        }

        Log.i(TAG, "🚀 Triggering version check (download + verify checksum, no install)...");
        helper.startVersionCheck(context);
        Log.i(TAG, "✅ OTA check triggered - monitor logcat for progress");
    }
}
