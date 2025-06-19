package com.augmentos.asg_client;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * Broadcast receiver for handling service restart requests from OTA updater
 */
public class AsgClientRestartReceiver extends BroadcastReceiver {
    private static final String TAG = "AsgClientRestartReceiver";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) {
            return;
        }

        String action = intent.getAction();

        if (AsgClientService.ACTION_RESTART_SERVICE.equals(action)) {
            Log.i(TAG, "Received restart request via broadcast");

            try {
                // Create intent to start the service
                Intent serviceIntent = new Intent(context, AsgClientService.class);
                serviceIntent.setAction(AsgClientService.ACTION_RESTART_SERVICE);

                // Start the service based on Android version
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    Log.i(TAG, "Starting foreground service via receiver");
                    context.startForegroundService(serviceIntent);
                } else {
                    Log.i(TAG, "Starting service via receiver");
                    context.startService(serviceIntent);
                }

                // Send restart complete broadcast
                Intent completeIntent = new Intent(AsgClientService.ACTION_RESTART_COMPLETE);
                completeIntent.setPackage("com.augmentos.otaupdater");
                context.sendBroadcast(completeIntent);
                Log.i(TAG, "Sent restart complete broadcast from receiver");

                // Also send heartbeat ack
                Intent ackIntent = new Intent("com.augmentos.asg_client.ACTION_HEARTBEAT_ACK");
                ackIntent.setPackage("com.augmentos.otaupdater");
                context.sendBroadcast(ackIntent);
                Log.i(TAG, "Sent heartbeat ack from receiver");
            } catch (Exception e) {
                Log.e(TAG, "Error starting service from receiver", e);
            }
        }
    }
}