package com.mentra.otaupdater.worker;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.BroadcastReceiver;
import android.content.SharedPreferences;
import android.util.Log;
import android.os.Handler;
import android.os.Looper;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import androidx.work.Data;
import com.mentra.otaupdater.helper.OtaHelper;
import com.mentra.otaupdater.helper.Constants;

public class RecoveryWorker extends Worker {
    private static final String TAG = "RecoveryWorker";
    private final OtaHelper otaHelper;
    private static final String PREFS_NAME = "RecoveryWorkerPrefs";
    private static final String KEY_LAST_RESTART = "last_restart_timestamp";
    private static final long MIN_RESTART_INTERVAL_MS = 5000; // 5 seconds minimum between restarts
    private static final String ASG_CLIENT_PACKAGE = "com.mentra.asg_client";
    private static final String ASG_CLIENT_SERVICE = "com.mentra.asg_client.AsgClientService";
    private static final String ACTION_RESTART_SERVICE = "com.mentra.asg_client.ACTION_RESTART_SERVICE";
    private static final String ACTION_RESTART_COMPLETE = "com.mentra.asg_client.ACTION_RESTART_COMPLETE";

    public RecoveryWorker(Context context, WorkerParameters params) {
        super(context, params);
        otaHelper = new OtaHelper(context);
    }

    private void sendRestartBroadcast() {
        // Check if we've recently sent a restart broadcast to prevent duplicates
        SharedPreferences prefs = getApplicationContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        long lastRestartTime = prefs.getLong(KEY_LAST_RESTART, 0);
        long currentTime = System.currentTimeMillis();

        if (currentTime - lastRestartTime < MIN_RESTART_INTERVAL_MS) {
            Log.w(TAG, "Skipping restart broadcast - too soon since last restart (" +
                    (currentTime - lastRestartTime) + "ms ago)");
            return;
        }

        // Save current time as last restart time
        prefs.edit().putLong(KEY_LAST_RESTART, currentTime).apply();

        Log.i(TAG, "Sending ASG Client service restart using multiple approaches");

        // 1. Try explicit service start first
        try {
            Intent serviceIntent = new Intent();
            serviceIntent.setComponent(new ComponentName(ASG_CLIENT_PACKAGE, ASG_CLIENT_SERVICE));
            serviceIntent.setAction(ACTION_RESTART_SERVICE);

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                Log.i(TAG, "Attempting to start foreground service explicitly");
                getApplicationContext().startForegroundService(serviceIntent);
            } else {
                Log.i(TAG, "Attempting to start service explicitly");
                getApplicationContext().startService(serviceIntent);
            }
            Log.i(TAG, "✅ Sent explicit service start");
        } catch (Exception e) {
            Log.e(TAG, "❌ Failed to start service explicitly", e);
        }

        // 2. Send broadcast as backup approach
        try {
            Intent restartIntent = new Intent(ACTION_RESTART_SERVICE);
            restartIntent.setPackage(ASG_CLIENT_PACKAGE);
            restartIntent.addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES);
            getApplicationContext().sendBroadcast(restartIntent);
            Log.i(TAG, "✅ Sent ASG Client restart broadcast: " + ACTION_RESTART_SERVICE);
        } catch (Exception e) {
            Log.e(TAG, "❌ Failed to send ASG Client restart broadcast", e);
        }

        // 3. Try starting the main activity which can then start the service
        try {
            Intent activityIntent = new Intent();
            activityIntent.setClassName(ASG_CLIENT_PACKAGE, ASG_CLIENT_PACKAGE + ".MainActivity");
            activityIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activityIntent.putExtra("start_service", true);
            getApplicationContext().startActivity(activityIntent);
            Log.i(TAG, "✅ Started main activity to trigger service start");
        } catch (Exception e) {
            Log.e(TAG, "❌ Failed to start main activity", e);
        }
    }

    private boolean waitForHeartbeats() {
        Log.d(TAG, "Waiting for heartbeats after restart...");
        final boolean[] heartbeatReceived = {false};
        final Object lock = new Object();

        // Add a timestamp to track when we last forwarded an acknowledgment
        final long[] lastForwardTime = {0};

        // Create a unique receiver that ONLY listens for our private action to avoid duplicate handling
        BroadcastReceiver tempReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                // Only process our private action
                if (Constants.ACTION_RECOVERY_HEARTBEAT_ACK.equals(intent.getAction())) {
                    Log.d(TAG, "Recovery worker processing heartbeat acknowledgment");
                    synchronized (lock) {
                        heartbeatReceived[0] = true;
                        lock.notify();
                    }
                }
            }
        };

        // Also create a receiver to observe the original acks and forward them
        BroadcastReceiver forwardingReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (Constants.ACTION_HEARTBEAT_ACK.equals(intent.getAction())) {
                    long currentTime = System.currentTimeMillis();

                    // Only forward if we haven't recently forwarded an acknowledgment
                    // This prevents duplicate acknowledgments from being forwarded
                    if (currentTime - lastForwardTime[0] > 1000) { // 1 second deduplication window
                        Log.d(TAG, "Recovery worker observed heartbeat acknowledgment - forwarding");
                        lastForwardTime[0] = currentTime;

                        // Forward a copy of the acknowledgment with our unique action
                        Intent forwardIntent = new Intent(Constants.ACTION_RECOVERY_HEARTBEAT_ACK);
                        forwardIntent.setPackage(getApplicationContext().getPackageName());
                        getApplicationContext().sendBroadcast(forwardIntent);
                    } else {
                        Log.d(TAG, "Recovery worker ignoring duplicate heartbeat acknowledgment (within deduplication window)");
                    }
                }
            }
        };

        // Register both receivers with appropriate filters
        IntentFilter recoveryFilter = new IntentFilter(Constants.ACTION_RECOVERY_HEARTBEAT_ACK);
        getApplicationContext().registerReceiver(tempReceiver, recoveryFilter, Context.RECEIVER_NOT_EXPORTED);

        IntentFilter originalFilter = new IntentFilter();
        originalFilter.addAction(Constants.ACTION_HEARTBEAT_ACK);
        originalFilter.addAction(Constants.ACTION_ASG_RESTART_COMPLETE);
        getApplicationContext().registerReceiver(forwardingReceiver, originalFilter, Context.RECEIVER_NOT_EXPORTED);

        try {
            synchronized (lock) {
                lock.wait(Constants.RECOVERY_HEARTBEAT_WAIT_MS);
            }
        } catch (InterruptedException e) {
            Log.w(TAG, "Wait for heartbeats interrupted", e);
        } finally {
            try {
                getApplicationContext().unregisterReceiver(tempReceiver);
                getApplicationContext().unregisterReceiver(forwardingReceiver);
            } catch (Exception e) {
                Log.w(TAG, "Error unregistering receivers", e);
            }
        }

        return heartbeatReceived[0];
    }

    /**
     * Sends a broadcast to explicitly unblock heartbeats
     */
    private void sendUnblockHeartbeatsSignal() {
        try {
            Log.i(TAG, "Explicitly sending unblock heartbeats signal");
            Intent unblockIntent = new Intent(Constants.ACTION_UNBLOCK_HEARTBEATS);
            unblockIntent.setPackage(getApplicationContext().getPackageName());
            getApplicationContext().sendBroadcast(unblockIntent);

            // As a fallback, send a copy of the recovery ack broadcast
            Intent recoveryAckIntent = new Intent(Constants.ACTION_RECOVERY_HEARTBEAT_ACK);
            recoveryAckIntent.setPackage(getApplicationContext().getPackageName());
            getApplicationContext().sendBroadcast(recoveryAckIntent);
        } catch (Exception e) {
            Log.e(TAG, "Failed to send unblock signal", e);
        }
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            Log.d(TAG, "🚀 Starting recovery work");

            // Send an immediate broadcast to unblock heartbeats
            sendUnblockHeartbeatsSignal();

            // Step 1: Try restarting the service multiple times
            boolean restartSuccessful = false;
            for (int attempt = 1; attempt <= Constants.MAX_RECOVERY_RESTART_ATTEMPTS; attempt++) {
                Log.i(TAG, "🔄 Restart attempt " + attempt + " of " + Constants.MAX_RECOVERY_RESTART_ATTEMPTS);
                sendRestartBroadcast();
                
                // Wait longer before checking for heartbeats to give the service time to start
                Log.d(TAG, "⏳ Waiting " + (Constants.RECOVERY_RESTART_WAIT_MS + 5000) + "ms for service to start...");
                Thread.sleep(Constants.RECOVERY_RESTART_WAIT_MS + 5000); // Add 5 extra seconds
                
                Log.d(TAG, "🔍 Checking for heartbeat acknowledgment...");
                if (waitForHeartbeats()) {
                    Log.i(TAG, "✅ App successfully recovered after restart");
                    restartSuccessful = true;
                    break;
                }
                
                Log.w(TAG, "❌ No heartbeat received after restart attempt " + attempt);
                // Send unblock signal before each retry
                sendUnblockHeartbeatsSignal();
            }

            // Step 2: If restart didn't work, try APK reinstallation
            if (!restartSuccessful) {
                Log.w(TAG, "💥 Restart attempts failed, attempting APK reinstallation");
                boolean reinstallSuccess = otaHelper.reinstallApkFromBackup();
                
                Data outputData = new Data.Builder()
                        .putBoolean("success", reinstallSuccess)
                        .putString("recovery_method", "reinstall")
                        .build();

                return reinstallSuccess ? Result.success(outputData) : Result.failure(outputData);
            }

            // If we got here, restart was successful
            Data outputData = new Data.Builder()
                    .putBoolean("success", true)
                    .putString("recovery_method", "restart")
                    .build();

            return Result.success(outputData);

        } catch (Exception e) {
            Log.e(TAG, "💥 Error during recovery work", e);
            Data errorData = new Data.Builder()
                    .putString("error", e.getMessage())
                    .build();
            return Result.failure(errorData);
        }
    }
}
