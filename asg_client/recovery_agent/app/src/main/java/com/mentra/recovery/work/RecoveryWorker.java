package com.mentra.recovery.work;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

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
  public Result doWork() {
    Context context = getApplicationContext();
    RecoveryStateStore store = new RecoveryStateStore(context);
    RecoveryTelemetry telemetry = new RecoveryTelemetry(context);
    int attempt = store.getAttempts();

    RestartStrategy restartStrategy = new RestartStrategy(context);
    restartStrategy.execute();
    if (waitForPong(context, RecoveryConstants.RESTART_GRACE_MS)) {
      store.setState(RecoveryConstants.STATE_COOLDOWN, "RESTART_SUCCESS");
      telemetry.emit("mentra_recovery_recovered", RecoveryConstants.STATE_HEALTHY, "RESTART_SUCCESS", attempt);
      return Result.success();
    }

    store.setState(RecoveryConstants.STATE_REINSTALLING_BACKUP, "RESTART_FAILED");
    telemetry.emit("mentra_recovery_reinstall_attempted", RecoveryConstants.STATE_REINSTALLING_BACKUP, "RESTART_FAILED", attempt);

    ReinstallStrategy reinstall = new ReinstallStrategy(context);
    if (!reinstall.execute()) {
      store.setState(RecoveryConstants.STATE_FAILED_NEEDS_MANUAL, "NO_VALID_BACKUP");
      telemetry.emit("mentra_recovery_failed", RecoveryConstants.STATE_FAILED_NEEDS_MANUAL, "NO_VALID_BACKUP", attempt);
      return Result.failure();
    }

    if (waitForPong(context, RecoveryConstants.REINSTALL_GRACE_MS)) {
      store.setState(RecoveryConstants.STATE_COOLDOWN, "REINSTALL_SUCCESS");
      telemetry.emit("mentra_recovery_recovered", RecoveryConstants.STATE_HEALTHY, "REINSTALL_SUCCESS", attempt);
      return Result.success();
    }

    store.setState(RecoveryConstants.STATE_FAILED_NEEDS_MANUAL, "REINSTALL_NO_HEARTBEAT");
    telemetry.emit("mentra_recovery_failed", RecoveryConstants.STATE_FAILED_NEEDS_MANUAL, "REINSTALL_NO_HEARTBEAT", attempt);
    return Result.failure();
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
        lock.wait(timeoutMs);
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
}
