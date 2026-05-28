package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import com.mentra.asg_client.reporting.domains.GeneralReporting;

public class RecoveryTelemetryReceiver extends BroadcastReceiver {
    private static final String TAG = "RecoveryTelemetryReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !"com.mentra.recovery.ACTION_TELEMETRY".equals(intent.getAction())) {
            return;
        }
        String event = intent.getStringExtra("event");
        String state = intent.getStringExtra("state");
        String reason = intent.getStringExtra("reason");
        int attempt = intent.getIntExtra("attempt", 0);
        Log.i(
                TAG,
                "Recovery telemetry event="
                        + event
                        + " state="
                        + state
                        + " reason="
                        + reason
                        + " attempt="
                        + attempt);
        boolean success = intent.getBooleanExtra("success", false);
        String version = state == null ? "unknown" : state;
        GeneralReporting.reportOtaEvent(
                context, event == null ? "recovery_event" : event, version, success);
    }
}
