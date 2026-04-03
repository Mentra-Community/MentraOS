package com.mentra.asg_client.io.uvc.core;

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

import com.mentra.asg_client.io.uvc.model.UvcConfig;

public class UvcBridgeService extends Service {
  public static final String TAG = "UvcBridgeService";
  public static final String ACTION_START_UVC = "com.mentra.asg_client.action.START_UVC";
  public static final String ACTION_STOP_UVC = "com.mentra.asg_client.action.STOP_UVC";
  public static final String ACTION_STATUS_UVC = "com.mentra.asg_client.action.STATUS_UVC";

  private static final String CHANNEL_ID = "uvc_bridge_channel";
  private static final int NOTIFICATION_ID = 9011;

  private UvcBridgeManager bridgeManager;

  @Override
  public void onCreate() {
    super.onCreate();
    bridgeManager = UvcRuntimeRegistry.get();
    if (bridgeManager == null) {
      bridgeManager = new UvcBridgeManager(getApplicationContext(), new com.mentra.asg_client.io.uvc.sink.UvcSinkFactory(), new UvcDeviceLocator());
      UvcRuntimeRegistry.set(bridgeManager);
    }
    createNotificationChannel();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    String action = intent != null ? intent.getAction() : null;
    if (action == null) {
      return START_STICKY;
    }

    switch (action) {
      case ACTION_START_UVC:
        startForeground(NOTIFICATION_ID, createNotification("UVC bridge active"));
        UvcConfig config = UvcConfig.fromIntent(intent);
        boolean started = bridgeManager.start(config);
        if (!started) {
          UvcBridgeManager.MetricsSnapshot failed = bridgeManager.getMetricsSnapshot();
          Log.w(TAG, "Start rejected: " + failed.lastErrorCode + " / " + failed.lastErrorMessage);
          stopForeground(STOP_FOREGROUND_REMOVE);
        } else {
          Log.i(TAG, "Start action handled with sink " + config.getSinkType());
        }
        break;
      case ACTION_STOP_UVC:
        bridgeManager.stop();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        Log.i(TAG, "Stop action handled");
        break;
      case ACTION_STATUS_UVC:
        UvcBridgeManager.MetricsSnapshot snapshot = bridgeManager.getMetricsSnapshot();
        Log.i(TAG,
            "status state=" + snapshot.state
                + " sink=" + snapshot.sinkName
                + " producer=" + snapshot.producerName
                + " produced=" + snapshot.producedFrames
                + " written=" + snapshot.writtenFrames
                + " dropped=" + snapshot.droppedFrames
                + " errorCode=" + snapshot.lastErrorCode
                + " errorMessage=" + snapshot.lastErrorMessage);
        break;
      default:
        Log.w(TAG, "Unknown action: " + action);
        break;
    }

    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    if (bridgeManager != null) {
      bridgeManager.stopSafely();
    }
    super.onDestroy();
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  private Notification createNotification(String contentText) {
    return new NotificationCompat.Builder(this, CHANNEL_ID)
        .setSmallIcon(android.R.drawable.presence_video_online)
        .setContentTitle("UVC Bridge")
        .setContentText(contentText)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .build();
  }

  private void createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return;
    }

    NotificationChannel channel = new NotificationChannel(
        CHANNEL_ID,
        "UVC Bridge",
        NotificationManager.IMPORTANCE_LOW);
    channel.setDescription("Mentra UVC bridge status");

    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager != null) {
      manager.createNotificationChannel(channel);
    }
  }
}
