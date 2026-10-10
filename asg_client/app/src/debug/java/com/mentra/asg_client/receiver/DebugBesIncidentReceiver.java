package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

import com.mentra.asg_client.io.bes.log.BesCrashDumpCollector;
import com.mentra.asg_client.io.bes.log.BesIncidentStore;

import org.json.JSONObject;

/**
 * Debug-only: lists the BES crash incident bundles, their states and the eviction summary as JSON
 * on logcat tag {@code BesIncident}, in 3000-character chunks.
 *
 * <p>Usage:
 *
 * <pre>
 *   adb shell am broadcast -a com.mentra.DEBUG_BES_INCIDENTS
 *   adb logcat -d -s BesIncident
 * </pre>
 *
 * The output is one {@code BEGIN} line, numbered {@code part} lines that concatenate to a single
 * JSON object, and an {@code END} line.
 */
public class DebugBesIncidentReceiver extends BroadcastReceiver {
    private static final String TAG = "BesIncident";
    public static final String ACTION_DEBUG_BES_INCIDENTS = "com.mentra.DEBUG_BES_INCIDENTS";
    private static final int CHUNK = 3000;

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_DEBUG_BES_INCIDENTS.equals(intent.getAction())) {
            return;
        }
        BesCrashDumpCollector collector = BesCrashDumpCollector.get();
        if (collector.store() == null) {
            // The service has not attached the collector (yet): read the files directly.
            collector.attach(context);
        }
        BesIncidentStore store = collector.store();
        if (store == null) {
            Log.e(TAG, "{\"error\":\"incident store unavailable\"}");
            return;
        }
        JSONObject snapshot = collector.debugSnapshot();
        String json = snapshot.toString();
        Log.i(TAG, "BEGIN bytes=" + json.length());
        for (int at = 0, part = 1; at < json.length(); at += CHUNK, part++) {
            Log.i(TAG, "part " + part + " " + json.substring(at, Math.min(json.length(), at + CHUNK)));
        }
        Log.i(TAG, "END");
    }
}
