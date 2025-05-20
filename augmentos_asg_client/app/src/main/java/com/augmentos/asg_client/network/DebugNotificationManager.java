package com.augmentos.asg_client.network;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.augmentos.asg_client.MainActivity;
import com.augmentos.asg_client.R;

/**
 * Utility class for showing debug notifications.
 * Particularly useful for services that can't use Toast messages.
 */
public class DebugNotificationManager {
    private static final int NOTIFICATION_ID_BASE = 12345;
    private static final int NOTIFICATION_ID_WIFI = 12346;
    private static final int NOTIFICATION_ID_HOTSPOT = 12347;
    private static final int NOTIFICATION_ID_DEVICE_TYPE = 12348;
    private static final String CHANNEL_ID = "asg_debug_channel";
    
    private final Context context;
    private final NotificationManager notificationManager;
    private int notificationCount = 0;
    
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
     * Show a debug notification with the given title and message
     * @param title The notification title
     * @param message The notification message
     */
    public void showDebugNotification(String title, String message) {
        PendingIntent contentIntent = PendingIntent.getActivity(
                context, 
                0, 
                new Intent(context, MainActivity.class), 
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(message)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(message))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(contentIntent)
                .setAutoCancel(true);
        
        // Use a different notification ID for each notification
        notificationManager.notify(NOTIFICATION_ID_BASE + notificationCount++, builder.build());
    }
    
    /**
     * Show a notification about the device type detection
     * @param isK900 true if the device is a K900, false otherwise
     */
    public void showDeviceTypeNotification(boolean isK900) {
        String title = "AugmentOS Device Detection";
        String message = isK900 ? 
                "Detected K900 device - using native WiFi APIs" : 
                "Non-K900 device - using fallback WiFi methods";
        
        PendingIntent contentIntent = PendingIntent.getActivity(
                context, 
                0, 
                new Intent(context, MainActivity.class), 
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(message)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(message))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(contentIntent)
                .setAutoCancel(true);
        
        // Use the fixed notification ID for device type
        notificationManager.notify(NOTIFICATION_ID_DEVICE_TYPE, builder.build());
    }
    
    /**
     * Show a notification about the WiFi state
     * @param isConnected true if connected to WiFi, false otherwise
     */
    public void showWifiStateNotification(boolean isConnected) {
        String title = "AugmentOS WiFi State";
        String message = isConnected ?
                "CONNECTED to WiFi network" :
                "DISCONNECTED from WiFi network";
        
        Log.d("DebugNotificationManager", "Showing WiFi state notification: " + message);
        
        PendingIntent contentIntent = PendingIntent.getActivity(
                context, 
                0, 
                new Intent(context, MainActivity.class), 
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(message)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(message))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(contentIntent)
                .setAutoCancel(true);
        
        // Always use the same notification ID for WiFi state updates
        notificationManager.notify(NOTIFICATION_ID_WIFI, builder.build());
    }
    
    /**
     * Show a notification about the hotspot state
     * @param isEnabled true if the hotspot is enabled, false otherwise
     */
    public void showHotspotStateNotification(boolean isEnabled) {
        String title = "AugmentOS Hotspot State";
        String message = isEnabled ?
                "Hotspot is enabled and running" :
                "Hotspot is disabled";
        
        PendingIntent contentIntent = PendingIntent.getActivity(
                context, 
                0, 
                new Intent(context, MainActivity.class), 
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(message)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(message))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(contentIntent)
                .setAutoCancel(true);
        
        // Always use the same notification ID for hotspot state updates
        notificationManager.notify(NOTIFICATION_ID_HOTSPOT, builder.build());
    }
    
    /**
     * Create the notification channel for Android 8.0+
     */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "AugmentOS Debug",
                    NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Debug notifications for AugmentOS");
            notificationManager.createNotificationChannel(channel);
        }
    }
}