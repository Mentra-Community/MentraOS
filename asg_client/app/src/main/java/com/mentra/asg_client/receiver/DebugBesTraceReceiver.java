package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.asg_client.io.bes.log.BesLogDeliveryGate;
import com.mentra.asg_client.io.bes.log.BesTraceTail;
import com.mentra.asg_client.service.core.AsgClientService;
import com.mentra.asg_client.service.core.processors.CommandProcessor;

/**
 * Debug override for the BES TRACE tail (mh_rlog delivery into the bes_trace store).
 *
 * Usage:
 *   adb shell am broadcast -a com.mentra.DEBUG_BES_TRACE --ez enabled false
 *   adb shell am broadcast -a com.mentra.DEBUG_BES_TRACE --ez enabled true
 *
 * Master switch (BesLogDeliveryGate, off by default). Everything below needs it on:
 *   adb shell am broadcast -a com.mentra.DEBUG_BES_TRACE -p com.mentra.asg_client --ez delivery true
 *
 * Persistence cost (OS-1988): the store logs one [ASG-BES-STORE] aggregate line per minute at
 * most. Dump the totals on demand, and optionally change the group commit for an A/B run:
 *   adb shell am broadcast -a com.mentra.DEBUG_BES_TRACE --ez dump_store true
 *   adb shell am broadcast -a com.mentra.DEBUG_BES_TRACE --ei group_batches 4 --el group_ms 250
 */
public class DebugBesTraceReceiver extends BroadcastReceiver {
    private static final String TAG = "DebugBesTraceReceiver";
    public static final String ACTION_DEBUG_BES_TRACE = "com.mentra.DEBUG_BES_TRACE";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_DEBUG_BES_TRACE.equals(intent.getAction())) {
            return;
        }

        if (intent.hasExtra("delivery")) {
            // Master switch for BES log delivery (BesLogDeliveryGate). Persisted; applied by
            // asking the BES for a fresh sr_syvr, which re-evaluates the caps.
            boolean on = intent.getBooleanExtra("delivery", false);
            BesLogDeliveryGate.setOverride(context, on);
            // Switching off must also send mh_rlog_sub {on:0} while the subscription is still
            // known: the later onWireCaps(null) forgets it without telling the BES, which would
            // keep sending delivery status lines.
            BesTraceTail.get().setEnabled(on);
            Log.i(TAG, "BES log delivery " + (on ? "enabled" : "disabled"));
            AsgClientService svc = AsgClientService.getInstance();
            CommandProcessor proc = svc != null ? svc.getCommandProcessor() : null;
            if (proc != null) {
                proc.refreshBesSystemVersion();
            }
            return;
        }

        boolean persistenceOnly = false;
        if (intent.hasExtra("group_batches")) {
            persistenceOnly = true;
            int batches = intent.getIntExtra("group_batches", 1);
            long ms = intent.getLongExtra("group_ms", 250);
            BesTraceTail.get().setGroupCommit(batches, ms);
            Log.i(TAG, "BES trace group commit max_batches=" + batches + " max_ms=" + ms);
        }
        if (intent.getBooleanExtra("dump_store", false)) {
            BesTraceTail.get().dumpStoreStats();
            return;
        }
        if (persistenceOnly && !intent.hasExtra("enabled")) {
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
