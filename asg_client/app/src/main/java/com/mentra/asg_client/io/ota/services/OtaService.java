package com.mentra.asg_client.io.ota.services;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.mentra.asg_client.io.ota.utils.OtaConstants;
import com.mentra.asg_client.io.ota.events.DownloadProgressEvent;
import com.mentra.asg_client.io.ota.events.InstallationProgressEvent;
import com.mentra.asg_client.io.ota.events.MtkOtaProgressEvent;
import com.mentra.asg_client.io.ota.helpers.OtaHelper;
import com.mentra.asg_client.events.BatteryStatusEvent;
import com.mentra.asg_client.SysControl;

import org.greenrobot.eventbus.EventBus;
import org.greenrobot.eventbus.Subscribe;
import org.greenrobot.eventbus.ThreadMode;

public class OtaService extends Service {
    private static final String TAG = OtaConstants.TAG;
    private static final String CHANNEL_ID = "ota_service_channel";
    private static final int NOTIFICATION_ID = 2001;
    
    private OtaHelper otaHelper;
    
    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "OtaService onCreate");
        
        // Create notification channel
        createNotificationChannel();
        
        // Start as foreground service
        startForeground(NOTIFICATION_ID, createNotification("OTA Service Running"));
        
        // TEMPORARY: Kill external OTA updater app if it's running
        // This prevents dual OTA checks when updating from older versions
        try {
            Log.w(TAG, "Stopping external OTA updater app to prevent conflicts");
            SysControl.stopApp(this, "com.augmentos.otaupdater");
            Log.i(TAG, "External OTA updater stopped");
        } catch (Exception e) {
            Log.e(TAG, "Failed to stop external OTA updater", e);
        }
        
        // Initialize OTA helper
        otaHelper = new OtaHelper(this);
        
        // Register EventBus
        if (!EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().register(this);
        }
        
        // OtaHelper will automatically start checking:
        // - After 15 seconds (initial check)
        // - Every 30 minutes (periodic checks)
        // - When WiFi becomes available
        Log.i(TAG, "OTA service initialized - checks will begin automatically");
    }
    
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "OtaService onStartCommand");
        return START_STICKY;
    }
    
    @Override
    public void onDestroy() {
        super.onDestroy();
        Log.d(TAG, "OtaService onDestroy");
        
        // Unregister EventBus
        if (EventBus.getDefault().isRegistered(this)) {
            EventBus.getDefault().unregister(this);
        }
        
        // Clean up OTA helper
        if (otaHelper != null) {
            otaHelper.cleanup();
        }
    }
    
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
    
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "OTA Update Service",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("OTA update service notifications");
            
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
    
    private Notification createNotification(String contentText) {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("ASG Client OTA")
                .setContentText(contentText)
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .build();
    }
    
    private void updateNotification(String contentText) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, createNotification(contentText));
        }
    }
    
    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onDownloadProgress(DownloadProgressEvent event) {
        Log.d(TAG, "Download progress: " + event.toString());
        
        switch (event.getStatus()) {
            case STARTED:
                updateNotification("Downloading update...");
                break;
            case PROGRESS:
                updateNotification("Downloading: " + event.getProgress() + "%");
                break;
            case FINISHED:
                updateNotification("Download complete");
                break;
            case FAILED:
                updateNotification("Download failed: " + event.getErrorMessage());
                break;
        }
    }
    
    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onInstallationProgress(InstallationProgressEvent event) {
        Log.d(TAG, "Installation progress: " + event.toString());
        
        switch (event.getStatus()) {
            case STARTED:
                updateNotification("Installing update...");
                break;
            case FINISHED:
                updateNotification("Installation complete");
                break;
            case FAILED:
                updateNotification("Installation failed: " + event.getErrorMessage());
                break;
        }
    }
    
    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onBatteryStatus(BatteryStatusEvent event) {
        // OtaHelper is already subscribed to EventBus and will receive this event directly
        // No need to re-post the event - this was causing an infinite loop
        Log.d(TAG, "Received battery status: " + event.getBatteryLevel() + "%, charging: " + event.isCharging());
    }
    
    @Subscribe(threadMode = ThreadMode.MAIN)
    public void onMtkOtaProgress(MtkOtaProgressEvent event) {
        Log.d(TAG, "MTK OTA progress: " + event.toString());
        
        switch (event.getStatus()) {
            case STARTED:
                updateNotification("MTK firmware update started");
                break;
            case WRITE_PROGRESS:
                updateNotification("Writing MTK firmware...");
                break;
            case UPDATE_PROGRESS:
                updateNotification("Installing MTK firmware...");
                break;
            case SUCCESS:
                updateNotification("MTK firmware updated successfully");
                // Send broadcast to notify app that MTK update is complete
                sendMtkUpdateCompleteMessage();
                break;
            case ERROR:
                updateNotification("MTK firmware update failed: " + event.getMessage());
                break;
        }
    }
    
    private void sendMtkUpdateCompleteMessage() {
        Log.i(TAG, "Sending MTK update complete broadcast");
        Intent intent = new Intent("com.mentra.asg_client.MTK_UPDATE_COMPLETE");
        sendBroadcast(intent);
    }
}