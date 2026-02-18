package com.mentra.asg_client.io.bluetooth.utils;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * Utility class for showing bluetooth-related debug notifications.
 * Particularly useful for services that can't use Toast messages.
 */
public class DebugNotificationManager {
    private static final int NOTIFICATION_ID_BASE = 22345;
    private static final int NOTIFICATION_ID_BT_STATE = 22346;
    private static final int NOTIFICATION_ID_BT_DATA = 22347;
    private static final int NOTIFICATION_ID_DEVICE_TYPE = 22348;
    private static final int NOTIFICATION_ID_MTU = 22349;
    private static final int NOTIFICATION_ID_ADVERTISING = 22350;
    private static final int NOTIFICATION_ID_GENERAL = 22351; // Fixed ID for general notifications
    private static final String CHANNEL_ID = "asg_bluetooth_debug_channel";
    
    private final Context context;
    private final NotificationManager notificationManager;
    
    /**
     * Create a new DebugNotificationManager
     * @param context The application context
     */
    public DebugNotificationManager(Context context) {
        this.context = context.getApplicationContext();
        this.notificationManager = 
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        createNotificationChannel();
    }
    
    /**
     * Create the notification channel for Android O and above
     */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "ASG Bluetooth Debug",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Debug notifications for Bluetooth operations");
            notificationManager.createNotificationChannel(channel);
        }
    }
    
    /**
     * Show a device type notification
     */
    public void showDeviceTypeNotification(boolean isConnected) {
        String title = "Device Type";
        String message = isConnected ? "Device connected" : "Device disconnected";
        
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(message)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setAutoCancel(true);
        
        // Use dedicated device type notification ID
        notificationManager.notify(NOTIFICATION_ID_DEVICE_TYPE, builder.build());
    }
    
    /**
     * Show a general notification
     */
    public void showNotification(String title, String message) {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(message)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setAutoCancel(true);
        
        // Use a fixed notification ID to prevent accumulating notifications
        // This will replace any existing general notification
        notificationManager.notify(NOTIFICATION_ID_GENERAL, builder.build());
    }
    
    /**
     * Show an advertising notification
     */
    public void showAdvertisingNotification(String deviceName) {
        String title = "Bluetooth Advertising";
        String message = "Advertising as: " + deviceName;
        
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(message)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setAutoCancel(true);
        
        // Use dedicated advertising notification ID
        notificationManager.notify(NOTIFICATION_ID_ADVERTISING, builder.build());
    }
    
    /**
     * Show a debug notification
     */
    public void showDebugNotification(String title, String message) {
        showNotification(title, message);
    }
    
    /**
     * Show a bluetooth state notification
     */
    public void showBluetoothStateNotification(boolean isConnected) {
        String title = "Bluetooth State";
        String message = isConnected ? "Bluetooth connected" : "Bluetooth disconnected";
        
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(message)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setAutoCancel(true);
        
        // Use dedicated bluetooth state notification ID
        notificationManager.notify(NOTIFICATION_ID_BT_STATE, builder.build());
    }
    
    /**
     * Cancel advertising notification
     */
    public void cancelAdvertisingNotification() {
        // Implementation would go here to cancel specific notification
        Log.d("DebugNotificationManager", "Canceling advertising notification");
    }
}