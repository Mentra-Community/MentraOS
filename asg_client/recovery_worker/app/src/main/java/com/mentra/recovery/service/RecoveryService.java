package com.mentra.recovery.service;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.mentra.recovery.downgrade.DowngradeController;
import com.mentra.recovery.health.HealthMonitor;
import com.mentra.recovery.health.InstallPauseNotifier;
import com.mentra.recovery.reset.ResetController;
import com.mentra.recovery.util.RecoveryConstants;
import com.mentra.recovery.R;

public class RecoveryService extends Service {
  private ResetController resetController;
  private HealthMonitor healthMonitor;
  private BroadcastReceiver pongReceiver;
  private BroadcastReceiver installStateReceiver;

  @Override
  public void onCreate() {
    super.onCreate();
    Log.i(RecoveryConstants.TAG, "RecoveryService onCreate");
    createNotificationChannel();
    startForeground(RecoveryConstants.NOTIFICATION_ID, createNotification());

    resetController = new ResetController(this);
    healthMonitor =
        new HealthMonitor(
            this,
            () -> {
              resetController.onAsgUnresponsive();
            });
    InstallPauseNotifier.setListener(paused -> healthMonitor.setPaused(paused));
    registerReceivers();
    healthMonitor.start();
    DowngradeController.resumeIfActive(this);
  }

  @Nullable
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    Log.i(RecoveryConstants.TAG, "RecoveryService onStartCommand");
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    super.onDestroy();
    Log.i(RecoveryConstants.TAG, "RecoveryService onDestroy");
    if (healthMonitor != null) {
      healthMonitor.stop();
    }
    InstallPauseNotifier.clearListener();
    unregisterReceivers();
  }

  private void registerReceivers() {
    pongReceiver =
        new BroadcastReceiver() {
          @Override
          public void onReceive(Context context, Intent intent) {
            if (RecoveryConstants.ACTION_PONG.equals(intent.getAction())) {
              healthMonitor.onPong();
              resetController.onAsgHealthy();
            }
          }
        };
    ContextCompat.registerReceiver(
        this,
        pongReceiver,
        new IntentFilter(RecoveryConstants.ACTION_PONG),
        RecoveryConstants.RECOVERY_HEARTBEAT_PERMISSION,
        null,
        ContextCompat.RECEIVER_EXPORTED);

    installStateReceiver =
        new BroadcastReceiver() {
          @Override
          public void onReceive(Context context, Intent intent) {
            if (RecoveryConstants.ACTION_INSTALL_IN_PROGRESS.equals(intent.getAction())) {
              new HotspotOtaFailsafe(context)
                  .setOwnedRestart(
                      intent.getBooleanExtra(
                          RecoveryConstants.EXTRA_HOTSPOT_OTA_RESTART, false));
              healthMonitor.setPaused(true);
              InstallPauseNotifier.setInstallPaused(true);
            } else if (RecoveryConstants.ACTION_INSTALL_COMPLETED.equals(intent.getAction())) {
              new HotspotOtaFailsafe(context).clear();
              healthMonitor.setPaused(false);
              InstallPauseNotifier.setInstallPaused(false);
            }
          }
        };
    IntentFilter installFilter = new IntentFilter();
    installFilter.addAction(RecoveryConstants.ACTION_INSTALL_IN_PROGRESS);
    installFilter.addAction(RecoveryConstants.ACTION_INSTALL_COMPLETED);
    ContextCompat.registerReceiver(
        this,
        installStateReceiver,
        installFilter,
        RecoveryConstants.RECOVERY_CONTROL_PERMISSION,
        null,
        ContextCompat.RECEIVER_EXPORTED);
  }

  private void unregisterReceivers() {
    try {
      unregisterReceiver(pongReceiver);
    } catch (Exception ignored) {
    }
    try {
      unregisterReceiver(installStateReceiver);
    } catch (Exception ignored) {
    }
  }

  private void createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return;
    }
    NotificationChannel channel =
        new NotificationChannel(
            RecoveryConstants.CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW);
    channel.setDescription(getString(R.string.notification_channel_description));
    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager != null) {
      manager.createNotificationChannel(channel);
    }
  }

  private Notification createNotification() {
    PendingIntent contentIntent =
        PendingIntent.getActivity(
            this,
            0,
            new Intent(),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    return new NotificationCompat.Builder(this, RecoveryConstants.CHANNEL_ID)
        .setContentTitle(getString(R.string.notification_title))
        .setContentText(getString(R.string.notification_text))
        .setSmallIcon(android.R.drawable.stat_notify_sync)
        .setContentIntent(contentIntent)
        .setOngoing(true)
        .build();
  }
}
