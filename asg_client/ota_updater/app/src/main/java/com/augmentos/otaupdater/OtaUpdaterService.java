package com.mentra.otaupdater;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.mentra.otaupdater.events.BatteryStatusEvent;
import com.mentra.otaupdater.events.DownloadProgressEvent;
import com.mentra.otaupdater.events.InstallationProgressEvent;
import com.mentra.otaupdater.helper.Constants;
import com.mentra.otaupdater.helper.OtaHelper;
import com.mentra.otaupdater.worker.RecoveryWorker;

import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.greenrobot.eventbus.ThreadMode;

import java.util.concurrent.TimeUnit;

import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

public class OtaUpdaterService extends Service {
    private static final String TAG = Constants.TAG;
    private static final int NOTIFICATION_ID = 1001;
    private static final String CHANNEL_ID = "ota_updater_channel";
    
    private OtaHelper otaHelper;
    private Handler heartbeatHandler;
    private Runnable heartbeatRunnable;
    
    private static final String PREFS_NAME = "OtaUpdaterPrefs";
    private static final long HEARTBEAT_INTERVAL = 6000; // 6 seconds
    private static final long HEARTBEAT_TIMEOUT = 10000; // 10 seconds
    
    private long lastHeartbeatReceived = 0;
    private boolean isPausedForInstallation = false;
    
    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "OtaUpdaterService onCreate");
        
        // Create notification channel
        createNotificationChannel();
        
        // Start as foreground service immediately
        startForeground(NOTIFICATION_ID, createNotification("OTA Updater Running", null));
        
        // Register EventBus
        EventBus.getDefault().register(this);
        
        // Initialize OTA helper
        otaHelper = new OtaHelper(this);
        
        // Register receivers
        registerReceivers();
        
        // Start heartbeat monitoring
        startHeartbeatMonitoring();
        
        // Schedule recovery worker
        scheduleRecoveryWorker();
        
        // Mark service as started
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .edit()
            .putLong("service_start_time", System.currentTimeMillis())
            .apply();
            
        Log.i(TAG, "OTA Updater Service initialized successfully");
    }
    
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "onStartCommand: " + (intent != null ? intent.getAction() : "null"));
        
        // Handle any specific commands if needed
        if (intent != null && intent.getAction() != null) {
            switch (intent.getAction()) {
                case "CHECK_UPDATES":
                    Log.d(TAG, "Manual update check requested");
                    otaHelper.startVersionCheck(this);
                    break;
                case "PAUSE_HEARTBEAT":
                    Log.d(TAG, "Pausing heartbeat for installation");
                    isPausedForInstallation = true;
                    break;
                case "RESUME_HEARTBEAT":
                    Log.d(TAG, "Resuming heartbeat after installation");
                    isPausedForInstallation = false;
                    lastHeartbeatReceived = System.currentTimeMillis();
                    break;
            }
        }
        
        return START_STICKY; // Restart if killed
    }
    
    @Override
    public void onDestroy() {
        Log.d(TAG, "OtaUpdaterService onDestroy");
        
        // Clean up
        if (heartbeatHandler != null) {
            heartbeatHandler.removeCallbacksAndMessages(null);
        }
        
        // Unregister receivers
        unregisterReceivers();
        
        // Unregister EventBus
        if (EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().unregister(this);
        }
        
        // Clean up OTA helper
        if (otaHelper != null) {
            otaHelper.cleanup();
        }
        
        super.onDestroy();
    }
    
    @Override
    public IBinder onBind(Intent intent) {
        return null; // Not providing binding
    }
    
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "OTA Updater",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("OTA Update Service");
            channel.setShowBadge(false);
            
            NotificationManager notificationManager = getSystemService(NotificationManager.class);
            if (notificationManager != null) {
                notificationManager.createNotificationChannel(channel);
            }
        }
    }
    
    private Notification createNotification(String text, Integer progress) {
        Intent notificationIntent = new Intent(this, MainActivity.class);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, notificationIntent, 
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("AugmentOS Updater")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setContentIntent(pendingIntent);
            
        if (progress != null) {
            builder.setProgress(100, progress, false);
        }
        
        return builder.build();
    }
    
    private void updateNotification(String text, Integer progress) {
        Notification notification = createNotification(text, progress);
        NotificationManagerCompat.from(this).notify(NOTIFICATION_ID, notification);
    }
    
    // EventBus handlers for download/installation progress
    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onDownloadProgress(DownloadProgressEvent event) {
        switch (event.getStatus()) {
            case STARTED:
                updateNotification("Downloading update...", 0);
                break;
            case PROGRESS:
                int percent = (int) ((event.getBytesDownloaded() * 100) / event.getTotalBytes());
                updateNotification("Downloading update...", percent);
                break;
            case FINISHED:
                updateNotification("Download complete", 100);
                break;
            case FAILED:
                updateNotification("Download failed: " + event.getErrorMessage(), null);
                break;
        }
    }
    
    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onInstallationProgress(InstallationProgressEvent event) {
        switch (event.getStatus()) {
            case STARTED:
                updateNotification("Installing update...", null);
                isPausedForInstallation = true;
                break;
            case FINISHED:
                updateNotification("Installation complete", null);
                isPausedForInstallation = false;
                lastHeartbeatReceived = System.currentTimeMillis();
                break;
            case FAILED:
                updateNotification("Installation failed: " + event.getErrorMessage(), null);
                isPausedForInstallation = false;
                lastHeartbeatReceived = System.currentTimeMillis();
                break;
        }
    }
    
    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onBatteryStatus(BatteryStatusEvent event) {
        // Update battery info in OtaHelper
        Log.d(TAG, "Battery status: " + event.getBatteryLevel() + "%, charging: " + event.isCharging());
    }
    
    private void startHeartbeatMonitoring() {
        heartbeatHandler = new Handler(Looper.getMainLooper());
        lastHeartbeatReceived = System.currentTimeMillis();
        
        heartbeatRunnable = new Runnable() {
            @Override
            public void run() {
                if (!isPausedForInstallation) {
                    sendHeartbeat();
                    checkHeartbeatTimeout();
                }
                heartbeatHandler.postDelayed(this, HEARTBEAT_INTERVAL);
            }
        };
        
        heartbeatHandler.postDelayed(heartbeatRunnable, HEARTBEAT_INTERVAL);
        Log.d(TAG, "Heartbeat monitoring started");
    }
    
    private void sendHeartbeat() {
        Intent heartbeatIntent = new Intent(Constants.ACTION_HEARTBEAT);
        heartbeatIntent.setPackage(Constants.ASG_CLIENT_PACKAGE);
        sendBroadcast(heartbeatIntent);
        Log.v(TAG, "Heartbeat sent");
    }
    
    private void checkHeartbeatTimeout() {
        long timeSinceLastHeartbeat = System.currentTimeMillis() - lastHeartbeatReceived;
        
        if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT) {
            Log.w(TAG, "Heartbeat timeout detected! Time since last: " + timeSinceLastHeartbeat + "ms");
            updateNotification("ASG Client not responding", null);
            
            // Trigger recovery if needed
            if (timeSinceLastHeartbeat > HEARTBEAT_TIMEOUT * 2) {
                Log.e(TAG, "Critical: ASG Client appears to be dead. Triggering recovery.");
                triggerRecovery();
            }
        }
    }
    
    private void triggerRecovery() {
        // Use WorkManager to trigger recovery
        WorkManager.getInstance(this).enqueue(
            new PeriodicWorkRequest.Builder(RecoveryWorker.class, 15, TimeUnit.MINUTES)
                .build()
        );
    }
    
    private void scheduleRecoveryWorker() {
        PeriodicWorkRequest recoveryWork = new PeriodicWorkRequest.Builder(
            RecoveryWorker.class, 
            15, TimeUnit.MINUTES
        ).build();
        
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "recovery_worker",
            ExistingPeriodicWorkPolicy.KEEP,
            recoveryWork
        );
        
        Log.d(TAG, "Recovery worker scheduled");
    }
    
    private final BroadcastReceiver heartbeatAckReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            Log.v(TAG, "Heartbeat ACK received");
            lastHeartbeatReceived = System.currentTimeMillis();
            updateNotification("OTA Updater Running", null);
        }
    };
    
    private final BroadcastReceiver installOtaReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            Log.i(TAG, "Install OTA broadcast received - pausing heartbeats");
            isPausedForInstallation = true;
        }
    };
    
    private final BroadcastReceiver updateCompletedReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            Log.i(TAG, "Update completed broadcast received - resuming heartbeats");
            isPausedForInstallation = false;
            lastHeartbeatReceived = System.currentTimeMillis();
        }
    };
    
    private void registerReceivers() {
        IntentFilter heartbeatAckFilter = new IntentFilter(Constants.ACTION_HEARTBEAT_ACK);
        registerReceiver(heartbeatAckReceiver, heartbeatAckFilter);
        
        IntentFilter installFilter = new IntentFilter(Constants.ACTION_INSTALL_OTA);
        registerReceiver(installOtaReceiver, installFilter);
        
        IntentFilter updateCompletedFilter = new IntentFilter(Constants.ACTION_UPDATE_COMPLETED);
        registerReceiver(updateCompletedReceiver, updateCompletedFilter);
        
        Log.d(TAG, "Broadcast receivers registered");
    }
    
    private void unregisterReceivers() {
        try {
            unregisterReceiver(heartbeatAckReceiver);
            unregisterReceiver(installOtaReceiver);
            unregisterReceiver(updateCompletedReceiver);
            Log.d(TAG, "Broadcast receivers unregistered");
        } catch (Exception e) {
            Log.e(TAG, "Error unregistering receivers", e);
        }
    }
}