package com.mentra.asg_client.service.system.managers;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.mentra.asg_client.MainActivity;

import static com.mentra.asg_client.AsgConstants.asgServiceNotificationId;

/**
 * Manages notifications for the AsgClientService.
 * This class follows the Single Responsibility Principle by handling only
 * notification-related functionality.
 */
public class AsgNotificationManager {
    private static final String TAG = "AsgNotificationManager";

    private final Context context;
    private final android.app.NotificationManager systemNotificationManager;
    
    // Notification configuration
    private final String notificationAppName = "ASG Client";
    private final String notificationDescription = "Running in foreground";
    private final String channelId = "asg_client";

    public AsgNotificationManager(Context context) {
        this.context = context;
        this.systemNotificationManager = (android.app.NotificationManager) 
            context.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    /**
     * Create or update the notification channel for Android O+
     */
    public void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                channelId,
                notificationAppName,
                android.app.NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription(notificationDescription);
            
            if (systemNotificationManager != null) {
                systemNotificationManager.createNotificationChannel(channel);
                Log.d(TAG, "✅ Notification channel created");
            }
        }
    }

    /**
     * Create the foreground service notification
     */
    public Notification createForegroundNotification() {
        // Create PendingIntent for notification tap
        PendingIntent action = PendingIntent.getActivity(
            context,
            0,
            new Intent(context, MainActivity.class),
            PendingIntent.FLAG_CANCEL_CURRENT | PendingIntent.FLAG_MUTABLE
        );

        // Build notification
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
            .setContentIntent(action)
            .setContentTitle(notificationAppName)
            .setContentText(notificationDescription)
            .setSmallIcon(com.mentra.asg_client.R.drawable.ic_launcher_foreground)
            .setTicker("...")
            .setOngoing(true);

        return builder.build();
    }

    /**
     * Update the notification with new content
     */
    public Notification updateNotification(String title, String content) {
        PendingIntent action = PendingIntent.getActivity(
            context,
            0,
            new Intent(context, MainActivity.class),
            PendingIntent.FLAG_CANCEL_CURRENT | PendingIntent.FLAG_MUTABLE
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, channelId)
            .setContentIntent(action)
            .setContentTitle(title != null ? title : notificationAppName)
            .setContentText(content != null ? content : notificationDescription)
            .setSmallIcon(com.mentra.asg_client.R.drawable.ic_launcher_foreground)
            .setTicker("...")
            .setOngoing(true);

        return builder.build();
    }

    /**
     * Show a notification with the given ID
     */
    public void showNotification(int notificationId, Notification notification) {
        if (systemNotificationManager != null) {
            systemNotificationManager.notify(notificationId, notification);
            Log.d(TAG, "📱 Notification shown with ID: " + notificationId);
        } else {
            Log.e(TAG, "❌ System notification manager is null");
        }
    }

    /**
     * Cancel a notification with the given ID
     */
    public void cancelNotification(int notificationId) {
        if (systemNotificationManager != null) {
            systemNotificationManager.cancel(notificationId);
            Log.d(TAG, "📱 Notification cancelled with ID: " + notificationId);
        }
    }

    /**
     * Cancel all notifications
     */
    public void cancelAllNotifications() {
        if (systemNotificationManager != null) {
            systemNotificationManager.cancelAll();
            Log.d(TAG, "📱 All notifications cancelled");
        }
    }

    /**
     * Get the channel ID used for notifications
     */
    public String getChannelId() {
        return channelId;
    }

    /**
     * Get the default notification ID
     */
    public int getDefaultNotificationId() {
        return asgServiceNotificationId;
    }
} 