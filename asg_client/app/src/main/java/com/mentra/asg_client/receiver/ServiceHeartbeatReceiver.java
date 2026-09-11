package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.io.ota.utils.OtaConstants;
import com.mentra.asg_client.service.core.AsgClientService;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

public class ServiceHeartbeatReceiver extends BroadcastReceiver {
    private static final String TAG = "ServiceHeartbeatReceiver";
    private static final SimpleDateFormat sdf =
            new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US);
    private static long lastHeartbeatTime = 0;
    private static final String ACTION_HEARTBEAT_LEGACY = "com.mentra.asg_client.ACTION_HEARTBEAT";
    private static final String ACTION_PING = "com.mentra.recovery.ACTION_PING";
    private static final String ACTION_PONG = "com.mentra.recovery.ACTION_PONG";
    private static final String RECOVERY_HEARTBEAT_PERMISSION =
            "com.mentra.recovery.permission.HEARTBEAT";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (OtaConstants.ACTION_DOWNGRADE_HANDOFF_RESULT.equals(action)) {
            boolean accepted = intent.getBooleanExtra(OtaConstants.EXTRA_HANDOFF_ACCEPTED, false);
            String reason = intent.getStringExtra(OtaConstants.EXTRA_HANDOFF_REASON);
            Log.i(TAG, "Downgrade handoff verdict: accepted=" + accepted + ", reason=" + reason);
            OtaHelper.onDowngradeHandoffResult(accepted, reason == null ? "" : reason);
            return;
        }
        if (ACTION_HEARTBEAT_LEGACY.equals(action) || ACTION_PING.equals(action)) {
            if (!AsgClientService.isServiceRunning()) {
                Log.w(TAG, "Ignoring recovery heartbeat because AsgClientService is not running");
                return;
            }

            long currentTime = System.currentTimeMillis();
            String timestamp = sdf.format(new Date(currentTime));

            if (lastHeartbeatTime > 0) {
                long timeSinceLastHeartbeat = currentTime - lastHeartbeatTime;
                Log.i(
                        TAG,
                        String.format(
                                "Received service heartbeat at %s (%.1f seconds since last"
                                        + " heartbeat)",
                                timestamp, timeSinceLastHeartbeat / 1000.0));
            } else {
                Log.i(TAG, "Received first service heartbeat at " + timestamp);
            }
            lastHeartbeatTime = currentTime;

            try {
                Intent pongIntent = new Intent(ACTION_PONG);
                pongIntent.setPackage("com.mentra.recovery");
                context.sendBroadcast(pongIntent, RECOVERY_HEARTBEAT_PERMISSION);
                Log.d(TAG, "Sent heartbeat acknowledgment");
            } catch (Exception e) {
                Log.e(TAG, "Failed to send heartbeat acknowledgment: " + e.getMessage(), e);
            }
        }
    }
}
