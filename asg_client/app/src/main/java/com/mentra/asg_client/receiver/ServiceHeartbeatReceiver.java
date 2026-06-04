package com.mentra.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Binder;
import android.util.Log;
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
    private static final String RECOVERY_PACKAGE = "com.mentra.recovery";
    private static final String ASG_PACKAGE = "com.mentra.asg_client";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (!isTrustedHeartbeatSender(context, action)) {
            return;
        }
        if (ACTION_HEARTBEAT_LEGACY.equals(action) || ACTION_PING.equals(action)) {
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

    /**
     * Manifest {@code android:permission} on this receiver already requires the broadcaster to
     * hold HEARTBEAT. {@code checkCallingPermission} is unreliable for cross-package broadcasts
     * on API 29–30; resolve the sender UID instead of {@code getSendingPackage()} (API 33+).
     */
    private boolean isTrustedHeartbeatSender(Context context, String action) {
        String sender = resolveSenderPackage(context);
        if (sender == null) {
            Log.w(TAG, "Ignoring heartbeat: unknown sender");
            return false;
        }
        if (ACTION_PING.equals(action)) {
            // Same-process delivery on API 29–30 reports our UID, not recovery's.
            if (!RECOVERY_PACKAGE.equals(sender) && !ASG_PACKAGE.equals(sender)) {
                Log.w(TAG, "Ignoring PING from unexpected sender: " + sender);
                return false;
            }
            return true;
        }
        if (ACTION_HEARTBEAT_LEGACY.equals(action)) {
            return ASG_PACKAGE.equals(sender);
        }
        return false;
    }

    private static String resolveSenderPackage(Context context) {
        int uid = Binder.getCallingUid();
        if (uid <= 0) {
            return null;
        }
        String[] packages = context.getPackageManager().getPackagesForUid(uid);
        if (packages == null || packages.length == 0) {
            return null;
        }
        return packages[0];
    }
}
