package com.augmentos.augmentos_core.microphone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;

import com.augmentos.augmentos_core.R;

/**
 * Dedicated foreground service for microphone functionality.
 * This service meets SDK 34 requirements for microphone access.
 */
public class MicrophoneService extends Service {
    private static final String TAG = "AugmentOS_MicrophoneService";
    private static final int NOTIFICATION_ID = 1002;
    private static final String CHANNEL_ID = "MicrophoneServiceChannel";

    @Override
    public void onCreate() {
        super.onCreate();
        Log.d(TAG, "MicrophoneService created");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.d(TAG, "Starting MicrophoneService as foreground service");
        
        // On Android 14+, we need to start in foreground immediately
        // to avoid ForegroundServiceDidNotStartInTimeException
        try {
            // Create channel first to ensure notification works
            createNotificationChannel();
            
            // Call startForeground immediately - this is critical for Android 14 (SDK 34)
            Notification notification = createNotification();
            startForeground(NOTIFICATION_ID, notification);
            
            Log.d(TAG, "Successfully started MicrophoneService in foreground");
        } catch (Exception e) {
            Log.e(TAG, "Error starting foreground service", e);
        }
        
        return START_NOT_STICKY; // Don't restart if killed
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null; // No binding needed
    }

    @Override
    public void onDestroy() {
        Log.d(TAG, "MicrophoneService destroyed");
        super.onDestroy();
    }

    private Notification createNotification() {
        // Create a notification that clearly shows microphone usage
        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Microphone Active")
                .setContentText("AugmentOS is using the microphone")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now) // Using system icon
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Microphone Service",
                    NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Indicates when AugmentOS is using the microphone");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }
}