package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.asg_client.service.core.AsgClientService;
import com.mentra.asg_client.service.core.processors.CommandProcessor;

/**
 * Debug override for the BES TRACE tail (mh_rlog delivery into the bes_trace store).
 *
 * Usage:
 *   adb shell am broadcast -a com.mentra.DEBUG_BES_TRACE --ez enabled false
 *   adb shell am broadcast -a com.mentra.DEBUG_BES_TRACE --ez enabled true
 */
public class DebugBesTraceReceiver extends BroadcastReceiver {
    private static final String TAG = "DebugBesTraceReceiver";
    public static final String ACTION_DEBUG_BES_TRACE = "com.mentra.DEBUG_BES_TRACE";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_DEBUG_BES_TRACE.equals(intent.getAction())) {
            return;
        }

        boolean enabled = intent.getBooleanExtra("enabled", true);

        AsgClientService service = AsgClientService.getInstance();
        if (service == null) {
            Log.e(TAG, "AsgClientService not running - cannot toggle BES trace tail");
            return;
        }

        CommandProcessor processor = service.getCommandProcessor();
        if (processor == null) {
            Log.e(TAG, "CommandProcessor not ready - cannot toggle BES trace tail");
            return;
        }

        processor.setBesTraceTailEnabled(enabled);
        Log.i(TAG, "BES trace tail " + (enabled ? "enabled" : "disabled"));
    }
}
