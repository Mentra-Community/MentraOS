package com.augmentos.asg_client.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

import com.augmentos.asg_client.AsgClientService;

public class ServiceHeartbeatReceiver extends BroadcastReceiver {
    private static final String TAG = "ServiceHeartbeatReceiver";
    private static final SimpleDateFormat sdf = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US);
    private static long lastHeartbeatTime = 0;
    private static final String ACTION_HEARTBEAT = "com.augmentos.asg_client.ACTION_HEARTBEAT";
    private static final String ACTION_HEARTBEAT_ACK = "com.augmentos.asg_client.ACTION_HEARTBEAT_ACK";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (ACTION_HEARTBEAT.equals(intent.getAction())) {
            long currentTime = System.currentTimeMillis();
            String timestamp = sdf.format(new Date(currentTime));
            
            if (lastHeartbeatTime > 0) {
                long timeSinceLastHeartbeat = currentTime - lastHeartbeatTime;
                Log.i(TAG, String.format("Received service heartbeat at %s (%.1f seconds since last heartbeat)", 
                    timestamp, timeSinceLastHeartbeat / 1000.0));
            } else {
                Log.i(TAG, "Received first service heartbeat at " + timestamp);
            }
            lastHeartbeatTime = currentTime;
            
            try {
                // Send acknowledgment back to monitor
                Intent ackIntent = new Intent(ACTION_HEARTBEAT_ACK);
                ackIntent.setPackage("com.augmentos.otaupdater");
                context.sendBroadcast(ackIntent);
                Log.d(TAG, "Sent heartbeat acknowledgment");
            } catch (Exception e) {
                Log.e(TAG, "Failed to send heartbeat acknowledgment: " + e.getMessage(), e);
            }
        }
    }
} 