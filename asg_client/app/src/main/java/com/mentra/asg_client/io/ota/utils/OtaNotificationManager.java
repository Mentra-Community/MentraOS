package com.mentra.asg_client.io.ota.utils;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.graphics.Color;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;

import com.mentra.asg_client.R;

/**
 * Manages notifications for OTA operations.
 * Provides centralized notification handling for OTA services.
 */
public class OtaNotificationManager {
    private static final String TAG = OtaConstants.TAG;
    
    public static final String CHANNEL_ID = "ota_service_channel";
    public static final String CHANNEL_NAME = "OTA Update Service";
    public static final String CHANNEL_DESCRIPTION = "Notifications for OTA update operations";
    
    public static final int NOTIFICATION_ID_SERVICE = 2001;
    public static final int NOTIFICATION_ID_DOWNLOAD = 2002;
    public static final int NOTIFICATION_ID_INSTALL = 2003;
    public static final int NOTIFICATION_ID_ERROR = 2004;
    
    private final Context context;
    private final NotificationManager notificationManager;
    
    public OtaNotificationManager(@NonNull Context context) {
        this.context = context;
        this.notificationManager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        createNotificationChannel();
    }
    
    /**
     * Create notification channel for Android O and above
     */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription(CHANNEL_DESCRIPTION);
            channel.enableLights(true);
            channel.setLightColor(Color.BLUE);
            channel.enableVibration(false);
            channel.setShowBadge(false);
            
            notificationManager.createNotificationChannel(channel);
        }
    }
    
    /**
     * Show OTA service running notification
     * @param contentText Content text for the notification
     */
    public void showServiceNotification(String contentText) {
        Notification notification = createServiceNotification(contentText);
        notificationManager.notify(NOTIFICATION_ID_SERVICE, notification);
    }
    
    /**
     * Show download progress notification
     * @param progress Download progress (0-100)
     * @param bytesDownloaded Bytes downloaded so far
     * @param totalBytes Total bytes to download
     */
    public void showDownloadNotification(int progress, long bytesDownloaded, long totalBytes) {
        String title = "Downloading Update";
        String content = String.format("Downloading... %d%% (%s / %s)", 
            progress, 
            OtaUtils.formatFileSize(bytesDownloaded), 
            OtaUtils.formatFileSize(totalBytes));
        
        Notification notification = createDownloadNotification(title, content, progress);
        notificationManager.notify(NOTIFICATION_ID_DOWNLOAD, notification);
    }
    
    /**
     * Show download completed notification
     */
    public void showDownloadCompletedNotification() {
        String title = "Download Completed";
        String content = "Update downloaded successfully";
        
        Notification notification = createDownloadNotification(title, content, 100);
        notificationManager.notify(NOTIFICATION_ID_DOWNLOAD, notification);
    }
    
    /**
     * Show installation notification
     * @param apkPath Path to the APK being installed
     */
    public void showInstallationNotification(String apkPath) {
        String title = "Installing Update";
        String content = "Installing update...";
        
        Notification notification = createInstallationNotification(title, content, apkPath);
        notificationManager.notify(NOTIFICATION_ID_INSTALL, notification);
    }
    
    /**
     * Show installation completed notification
     */
    public void showInstallationCompletedNotification() {
        String title = "Installation Completed";
        String content = "Update installed successfully";
        
        Notification notification = createInstallationNotification(title, content, null);
        notificationManager.notify(NOTIFICATION_ID_INSTALL, notification);
    }
    
    /**
     * Show error notification
     * @param title Error title
     * @param error Error message
     */
    public void showErrorNotification(String title, String error) {
        Notification notification = createErrorNotification(title, error);
        notificationManager.notify(NOTIFICATION_ID_ERROR, notification);
    }
    
    /**
     * Update download notification
     * @param progress Download progress (0-100)
     * @param bytesDownloaded Bytes downloaded so far
     * @param totalBytes Total bytes to download
     */
    public void updateDownloadNotification(int progress, long bytesDownloaded, long totalBytes) {
        showDownloadNotification(progress, bytesDownloaded, totalBytes);
    }
    
    /**
     * Cancel service notification
     */
    public void cancelServiceNotification() {
        notificationManager.cancel(NOTIFICATION_ID_SERVICE);
    }
    
    /**
     * Cancel download notification
     */
    public void cancelDownloadNotification() {
        notificationManager.cancel(NOTIFICATION_ID_DOWNLOAD);
    }
    
    /**
     * Cancel installation notification
     */
    public void cancelInstallationNotification() {
        notificationManager.cancel(NOTIFICATION_ID_INSTALL);
    }
    
    /**
     * Cancel error notification
     */
    public void cancelErrorNotification() {
        notificationManager.cancel(NOTIFICATION_ID_ERROR);
    }
    
    /**
     * Cancel all OTA notifications
     */
    public void cancelAllNotifications() {
        notificationManager.cancel(NOTIFICATION_ID_SERVICE);
        notificationManager.cancel(NOTIFICATION_ID_DOWNLOAD);
        notificationManager.cancel(NOTIFICATION_ID_INSTALL);
        notificationManager.cancel(NOTIFICATION_ID_ERROR);
    }
    
    /**
     * Create service notification
     */
    private Notification createServiceNotification(String contentText) {
        return new NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle("OTA Update Service")
            .setContentText(contentText)
            .setSmallIcon(R.drawable.ic_system_update)
            .setOngoing(true)
            .setAutoCancel(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
    }
    
    /**
     * Create download notification
     */
    private Notification createDownloadNotification(String title, String content, int progress) {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(content)
            .setSmallIcon(R.drawable.ic_download)
            .setOngoing(true)
            .setAutoCancel(false)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS);
        
        if (progress >= 0 && progress <= 100) {
            builder.setProgress(100, progress, false);
        }
        
        return builder.build();
    }
    
    /**
     * Create installation notification
     */
    private Notification createInstallationNotification(String title, String content, String apkPath) {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(content)
            .setSmallIcon(R.drawable.ic_install)
            .setOngoing(true)
            .setAutoCancel(false)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS);
        
        return builder.build();
    }
    
    /**
     * Create error notification
     */
    private Notification createErrorNotification(String title, String error) {
        return new NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(error)
            .setSmallIcon(R.drawable.ic_error)
            .setOngoing(false)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .build();
    }
} 