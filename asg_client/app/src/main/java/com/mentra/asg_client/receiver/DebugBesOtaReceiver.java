package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Compatibility receiver that rejects the retired direct BES OTA adb entry point.
 *
 * <p>Direct installs cannot prove immutable release metadata or durable session ownership. Use a
 * phone-driven staging manifest so development tests exercise the production admission gate. The
 * old action remains registered only so existing scripts fail loudly.
 */
public class DebugBesOtaReceiver extends BroadcastReceiver {
    private static final String TAG = "DebugBesOtaReceiver";
    public static final String ACTION_DEBUG_BES_OTA = "com.mentra.DEBUG_BES_OTA";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!ACTION_DEBUG_BES_OTA.equals(intent.getAction())) {
            return;
        }

        Log.w(TAG, "========================================");
        Log.w(TAG, "⚠️ DEBUG BES OTA TRIGGERED VIA ADB ⚠️");
        Log.w(TAG, "========================================");

        // Raw-path starts bypass release metadata, artifact identity, and durable session
        // ownership. Use the phone-driven staging OTA flow so the same safety gate is exercised.
        Log.e(TAG, "❌ Direct BES OTA broadcast is disabled; use a validated staging manifest");
    }
}
