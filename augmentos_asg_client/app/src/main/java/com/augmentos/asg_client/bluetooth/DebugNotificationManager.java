package com.augmentos.asg_client.bluetooth;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

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
    private static final String CHANNEL_ID = "asg_bluetooth_debug_channel";
    
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
                new Intent(context, context.getClass()), 
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
        String title = "AugmentOS Bluetooth Detection";
        String message = isK900 ? 
                "Detected K900 device - using serial UART for BT communication" : 
                "Non-K900 device - using standard BLE APIs";
        
        PendingIntent contentIntent = PendingIntent.getActivity(
                context, 
                0, 
                new Intent(context, context.getClass()), 
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
     * Show a notification about the Bluetooth connection state
     * @param isConnected true if connected, false otherwise
     */
    public void showBluetoothStateNotification(boolean isConnected) {
        String title = "AugmentOS Bluetooth State";
        String message = isConnected ?
                "Connected to companion device" :
                "Disconnected from companion device";
        
        PendingIntent contentIntent = PendingIntent.getActivity(
                context, 
                0, 
                new Intent(context, context.getClass()), 
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(message)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(message))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(contentIntent)
                .setAutoCancel(true);
        
        // If disconnected, cancel the MTU notification
        if (!isConnected) {
            notificationManager.cancel(NOTIFICATION_ID_MTU);
        }
        
        // Always use the same notification ID for BT state updates
        notificationManager.notify(NOTIFICATION_ID_BT_STATE, builder.build());
    }
    
    /**
     * Show a notification about received data
     * @param dataSize The size of the received data
     */
    public void showDataReceivedNotification(int dataSize) {
        String title = "AugmentOS Bluetooth Data";
        String message = "Received " + dataSize + " bytes of data";
        
        PendingIntent contentIntent = PendingIntent.getActivity(
                context, 
                0, 
                new Intent(context, context.getClass()), 
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(message)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(message))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(contentIntent)
                .setAutoCancel(true);
        
        // Always use the same notification ID for data updates
        notificationManager.notify(NOTIFICATION_ID_BT_DATA, builder.build());
    }
    
    /**
     * Show a notification about MTU size negotiation
     * @param mtuSize The negotiated MTU size
     */
    public void showMtuNegotiationNotification(int mtuSize) {
        String title = "AugmentOS Bluetooth MTU";
        String message = "Negotiated MTU size: " + mtuSize + " bytes";
        
        PendingIntent contentIntent = PendingIntent.getActivity(
                context, 
                0, 
                new Intent(context, context.getClass()), 
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(message)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(message))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(contentIntent)
                .setAutoCancel(true);
        
        // Always use the same notification ID for MTU updates
        notificationManager.notify(NOTIFICATION_ID_MTU, builder.build());
    }
    
    /**
     * Show a notification about advertising status
     * @param deviceName The name being advertised
     */
    public void showAdvertisingNotification(String deviceName) {
        String title = "AugmentOS Bluetooth";
        String message = "Started advertising as \"" + deviceName + "\"";
        
        PendingIntent contentIntent = PendingIntent.getActivity(
                context, 
                0, 
                new Intent(context, context.getClass()), 
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle(title)
                .setContentText(message)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(message))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setContentIntent(contentIntent)
                .setAutoCancel(true);
        
        // Always use the same notification ID for advertising updates
        notificationManager.notify(NOTIFICATION_ID_ADVERTISING, builder.build());
    }
    
    /**
     * Cancel the advertising notification
     */
    public void cancelAdvertisingNotification() {
        notificationManager.cancel(NOTIFICATION_ID_ADVERTISING);
    }
    
    /**
     * Create the notification channel for Android 8.0+
     */
    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "AugmentOS Bluetooth Debug",
                    NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Debug notifications for AugmentOS Bluetooth");
            notificationManager.createNotificationChannel(channel);
        }
    }
}