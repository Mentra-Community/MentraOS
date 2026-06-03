package com.mentra.recovery.work;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.mentra.recovery.R;
import com.mentra.recovery.reset.RecoveryStateStore;
import com.mentra.recovery.reset.ReinstallStrategy;
import com.mentra.recovery.reset.RestartStrategy;
import com.mentra.recovery.telemetry.RecoveryTelemetry;
import com.mentra.recovery.util.RecoveryConstants;

public class RecoveryWorker extends Worker {
  public RecoveryWorker(@NonNull Context context, @NonNull WorkerParameters params) {
    super(context, params);
  }

  @NonNull
  @Override
  public ForegroundInfo getForegroundInfo() {
    Context context = getApplicationContext();
    createNotificationChannelIfNeeded(context);
    Notification notification =
        new NotificationCompat.Builder(context, RecoveryConstants.CHANNEL_ID)
            .setContentTitle(context.getString(R.string.notification_title))
            .setContentText("Running recovery workflow")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .build();
    return new ForegroundInfo(RecoveryConstants.NOTIFICATION_ID, notification);
  }

  @NonNull
  @Override
  public Result doWork() {
    Context context = getApplicationContext();
    RecoveryStateStore store = new RecoveryStateStore(context);
    RecoveryTelemetry telemetry = new RecoveryTelemetry(context);
    int attempt = store.getAttempts();

    RestartStrategy restartStrategy = new RestartStrategy(context);
    restartStrategy.execute();
    if (waitForPong(context, RecoveryConstants.RESTART_GRACE_MS)) {
      store.setState(RecoveryConstants.STATE_COOLDOWN, "RESTART_SUCCESS");
      telemetry.emit("mentra_recovery_recovered", RecoveryConstants.STATE_HEALTHY, "RESTART_SUCCESS", attempt, true);
      return Result.success();
    }

    store.setState(RecoveryConstants.STATE_REINSTALLING_BACKUP, "RESTART_FAILED");
    telemetry.emit(
        "mentra_recovery_reinstall_attempted",
        RecoveryConstants.STATE_REINSTALLING_BACKUP,
        "RESTART_FAILED",
        attempt,
        false);
    context.sendBroadcast(new Intent(RecoveryConstants.ACTION_INSTALL_IN_PROGRESS).setPackage(RecoveryConstants.RECOVERY_PACKAGE));

    ReinstallStrategy reinstall = new ReinstallStrategy(context);
    if (!reinstall.execute()) {
      context.sendBroadcast(new Intent(RecoveryConstants.ACTION_INSTALL_COMPLETED).setPackage(RecoveryConstants.RECOVERY_PACKAGE));
      store.setState(RecoveryConstants.STATE_FAILED_NEEDS_MANUAL, "NO_VALID_BACKUP");
      telemetry.emit(
          "mentra_recovery_failed", RecoveryConstants.STATE_FAILED_NEEDS_MANUAL, "NO_VALID_BACKUP", attempt, false);
      return Result.failure();
    }

    if (waitForPong(context, RecoveryConstants.REINSTALL_GRACE_MS)) {
      return completeReinstallSuccess(context, store, telemetry, attempt, "REINSTALL_SUCCESS");
    }

    Log.i(
        RecoveryConstants.TAG,
        "No PONG during reinstall grace; waiting "
            + RecoveryConstants.REINSTALL_LATE_PONG_GRACE_MS
            + "ms for late heartbeat");
    if (waitForPong(context, RecoveryConstants.REINSTALL_LATE_PONG_GRACE_MS)) {
      return completeReinstallSuccess(context, store, telemetry, attempt, "REINSTALL_LATE_PONG");
    }

    context.sendBroadcast(new Intent(RecoveryConstants.ACTION_INSTALL_COMPLETED).setPackage(RecoveryConstants.RECOVERY_PACKAGE));
    store.setState(RecoveryConstants.STATE_FAILED_NEEDS_MANUAL, "REINSTALL_NO_HEARTBEAT");
    telemetry.emit(
        "mentra_recovery_failed",
        RecoveryConstants.STATE_FAILED_NEEDS_MANUAL,
        "REINSTALL_NO_HEARTBEAT",
        attempt,
        false);
    return Result.failure();
  }

  private Result completeReinstallSuccess(
      Context context,
      RecoveryStateStore store,
      RecoveryTelemetry telemetry,
      int attempt,
      String reason) {
    context.sendBroadcast(
        new Intent(RecoveryConstants.ACTION_INSTALL_COMPLETED)
            .setPackage(RecoveryConstants.RECOVERY_PACKAGE));
    store.setState(RecoveryConstants.STATE_COOLDOWN, reason);
    telemetry.emit("mentra_recovery_recovered", RecoveryConstants.STATE_HEALTHY, reason, attempt, true);
    return Result.success();
  }

  private boolean waitForPong(Context context, long timeoutMs) {
    final Object lock = new Object();
    final boolean[] gotAck = {false};
    BroadcastReceiver pongReceiver =
        new BroadcastReceiver() {
          @Override
          public void onReceive(Context ctx, Intent intent) {
            if (RecoveryConstants.ACTION_PONG.equals(intent.getAction())) {
              synchronized (lock) {
                gotAck[0] = true;
                lock.notifyAll();
              }
            }
          }
        };
    try {
      context.registerReceiver(
          pongReceiver,
          new IntentFilter(RecoveryConstants.ACTION_PONG),
          Context.RECEIVER_NOT_EXPORTED);
      synchronized (lock) {
        long deadline = SystemClock.elapsedRealtime() + timeoutMs;
        while (!gotAck[0]) {
          long remaining = deadline - SystemClock.elapsedRealtime();
          if (remaining <= 0) {
            break;
          }
          lock.wait(remaining);
        }
      }
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      Log.e(RecoveryConstants.TAG, "Interrupted while waiting for pong", e);
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Receiver registration failed while waiting for pong", e);
    } finally {
      try {
        context.unregisterReceiver(pongReceiver);
      } catch (Exception ignored) {
      }
    }
    return gotAck[0];
  }

  private void createNotificationChannelIfNeeded(Context context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
      return;
    }
    NotificationManager manager = context.getSystemService(NotificationManager.class);
    if (manager == null || manager.getNotificationChannel(RecoveryConstants.CHANNEL_ID) != null) {
      return;
    }
    NotificationChannel channel =
        new NotificationChannel(
            RecoveryConstants.CHANNEL_ID,
            context.getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW);
    channel.setDescription(context.getString(R.string.notification_channel_description));
    manager.createNotificationChannel(channel);
  }
}
