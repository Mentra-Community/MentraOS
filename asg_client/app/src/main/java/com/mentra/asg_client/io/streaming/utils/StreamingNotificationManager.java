package com.mentra.asg_client.io.streaming.utils;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;

import com.mentra.asg_client.R;
import com.mentra.asg_client.io.streaming.ui.StreamingActivity;

/**
 * Manages notifications for streaming operations.
 * Provides centralized notification handling for streaming services.
 */
public class StreamingNotificationManager {
    private static final String TAG = "StreamingNotificationManager";
    
    public static final String CHANNEL_ID = "StreamingChannel";
    public static final String CHANNEL_NAME = "Streaming Notifications";
    public static final String CHANNEL_DESCRIPTION = "Notifications for streaming operations";
    
    public static final int NOTIFICATION_ID_STREAMING = 8888;
    public static final int NOTIFICATION_ID_RECONNECTING = 8889;
    public static final int NOTIFICATION_ID_ERROR = 8890;
    
    private final Context context;
    private final NotificationManager notificationManager;
    
    public StreamingNotificationManager(@NonNull Context context) {
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
     * Show streaming active notification
     * @param rtmpUrl The RTMP URL being streamed to
     * @param streamDuration Duration of the stream in milliseconds
     */
    public void showStreamingNotification(String rtmpUrl, long streamDuration) {
        String title = "Live Streaming";
        String content = "Streaming to: " + extractServerName(rtmpUrl);
        
        if (streamDuration > 0) {
            content += " • " + StreamingUtils.formatDuration(streamDuration);
        }
        
        Notification notification = createStreamingNotification(title, content, rtmpUrl);
        notificationManager.notify(NOTIFICATION_ID_STREAMING, notification);
    }
    
    /**
     * Show reconnecting notification
     * @param attempt Current reconnection attempt
     * @param maxAttempts Maximum reconnection attempts
     * @param reason Reason for reconnection
     */
    public void showReconnectingNotification(int attempt, int maxAttempts, String reason) {
        String title = "Reconnecting...";
        String content = String.format("Attempt %d/%d • %s", attempt, maxAttempts, reason);
        
        Notification notification = createReconnectingNotification(title, content);
        notificationManager.notify(NOTIFICATION_ID_RECONNECTING, notification);
    }
    
    /**
     * Show streaming error notification
     * @param error Error message
     */
    public void showErrorNotification(String error) {
        String title = "Streaming Error";
        String content = error != null ? error : "Unknown error occurred";
        
        Notification notification = createErrorNotification(title, content);
        notificationManager.notify(NOTIFICATION_ID_ERROR, notification);
    }
    
    /**
     * Update streaming notification with new duration
     * @param rtmpUrl The RTMP URL being streamed to
     * @param streamDuration Duration of the stream in milliseconds
     */
    public void updateStreamingNotification(String rtmpUrl, long streamDuration) {
        showStreamingNotification(rtmpUrl, streamDuration);
    }
    
    /**
     * Cancel streaming notification
     */
    public void cancelStreamingNotification() {
        notificationManager.cancel(NOTIFICATION_ID_STREAMING);
    }
    
    /**
     * Cancel reconnecting notification
     */
    public void cancelReconnectingNotification() {
        notificationManager.cancel(NOTIFICATION_ID_RECONNECTING);
    }
    
    /**
     * Cancel error notification
     */
    public void cancelErrorNotification() {
        notificationManager.cancel(NOTIFICATION_ID_ERROR);
    }
    
    /**
     * Cancel all streaming notifications
     */
    public void cancelAllNotifications() {
        notificationManager.cancel(NOTIFICATION_ID_STREAMING);
        notificationManager.cancel(NOTIFICATION_ID_RECONNECTING);
        notificationManager.cancel(NOTIFICATION_ID_ERROR);
    }
    
    /**
     * Create streaming notification
     */
    private Notification createStreamingNotification(String title, String content, String rtmpUrl) {
        Intent intent = new Intent(context, StreamingActivity.class);
        if (rtmpUrl != null) {
            intent.putExtra("rtmp_url", rtmpUrl);
        }
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        
        PendingIntent pendingIntent = PendingIntent.getActivity(
            context, 0, intent, 
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        
        return new NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(content)
            .setSmallIcon(R.drawable.ic_streaming)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setAutoCancel(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
    }
    
    /**
     * Create reconnecting notification
     */
    private Notification createReconnectingNotification(String title, String content) {
        return new NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(content)
            .setSmallIcon(R.drawable.ic_warning)
            .setOngoing(true)
            .setAutoCancel(false)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build();
    }
    
    /**
     * Create error notification
     */
    private Notification createErrorNotification(String title, String content) {
        return new NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(content)
            .setSmallIcon(R.drawable.ic_error)
            .setOngoing(false)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .build();
    }
    
    /**
     * Extract server name from RTMP URL for display
     */
    private String extractServerName(String rtmpUrl) {
        if (rtmpUrl == null || rtmpUrl.trim().isEmpty()) {
            return "Unknown Server";
        }
        
        try {
            String serverUrl = StreamingUtils.extractServerUrl(rtmpUrl);
            if (serverUrl != null) {
                // Remove protocol prefix
                if (serverUrl.startsWith("rtmp://")) {
                    serverUrl = serverUrl.substring(7);
                } else if (serverUrl.startsWith("rtmps://")) {
                    serverUrl = serverUrl.substring(8);
                } else if (serverUrl.startsWith("rtmpt://")) {
                    serverUrl = serverUrl.substring(8);
                }
                
                // Remove port if present
                int portIndex = serverUrl.indexOf(':');
                if (portIndex != -1) {
                    serverUrl = serverUrl.substring(0, portIndex);
                }
                
                // Remove path if present
                int pathIndex = serverUrl.indexOf('/');
                if (pathIndex != -1) {
                    serverUrl = serverUrl.substring(0, pathIndex);
                }
                
                return serverUrl.isEmpty() ? "Unknown Server" : serverUrl;
            }
        } catch (Exception e) {
            // Ignore parsing errors
        }
        
        return "Unknown Server";
    }
} 