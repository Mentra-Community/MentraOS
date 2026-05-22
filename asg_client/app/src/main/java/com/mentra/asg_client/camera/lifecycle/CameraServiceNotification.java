package com.mentra.asg_client.camera.lifecycle;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.mentra.asg_client.R;

/** Foreground notification wiring for the camera service. */
public final class CameraServiceNotification {

    private CameraServiceNotification() {}

    public static void createNotificationChannel(Service service, String channelId) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    channelId,
                    "Camera Neo Service Channel",
                    NotificationManager.IMPORTANCE_LOW
            );
            NotificationManager manager = service.getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    public static void showForeground(Service service, String channelId, int notificationId,
            String title, String message) {
        NotificationCompat.Builder builder = new NotificationCompat.Builder(service, channelId)
                .setSmallIcon(R.drawable.ic_launcher_foreground)
                .setContentTitle(title)
                .setContentText(message)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setAutoCancel(false);

        service.startForeground(notificationId, builder.build());
    }
}
