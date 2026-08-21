package com.mentra.recovery.work;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import androidx.work.ForegroundInfo;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.mentra.recovery.R;
import com.mentra.recovery.backup.BackupStore;
import com.mentra.recovery.downgrade.DowngradeTransactionStore;
import com.mentra.recovery.health.InstallPauseNotifier;
import com.mentra.recovery.reset.RecoveryStateStore;
import com.mentra.recovery.reset.ReinstallStrategy;
import com.mentra.recovery.reset.RestartStrategy;
import com.mentra.recovery.service.HotspotOtaFailsafe;
import com.mentra.recovery.telemetry.RecoveryTelemetry;
import com.mentra.recovery.util.RecoveryConstants;

public class RecoveryWorker extends Worker {
  private static final long WAIT_PING_INTERVAL_MS = 3000L;

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
            .setContentText(context.getString(R.string.notification_recovery_workflow))
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

    // A pinned downgrade deliberately uninstalls/reinstalls ASG, so its unresponsiveness is
    // expected. Heartbeat recovery must stand down — reinstalling the (higher-version) backup
    // would fight the downgrade. Checked here for an already-enqueued worker that predates the
    // transaction, and again right before the reinstall for a transaction that begins mid-run.
    if (new DowngradeTransactionStore(context).isActive()) {
      Log.i(RecoveryConstants.TAG, "Downgrade transaction active; skipping heartbeat recovery");
      return Result.success();
    }

    RestartStrategy restartStrategy = new RestartStrategy(context);
    restartStrategy.execute();
    if (waitForPong(context, RecoveryConstants.RESTART_GRACE_MS)) {
      store.setState(RecoveryConstants.STATE_COOLDOWN, "RESTART_SUCCESS");
      telemetry.emit("mentra_recovery_recovered", RecoveryConstants.STATE_HEALTHY, "RESTART_SUCCESS", attempt, true);
      return Result.success();
    }

    // Guard: a late PONG may have arrived after the restart wait window closed.
    // If ASG is already healthy, skip reinstall to avoid replacing a running app.
    String stateAfterRestart = store.getState();
    if (RecoveryConstants.STATE_HEALTHY.equals(stateAfterRestart)
        || RecoveryConstants.STATE_COOLDOWN.equals(stateAfterRestart)) {
      Log.i(RecoveryConstants.TAG, "ASG became healthy before reinstall; aborting reinstall");
      store.setState(RecoveryConstants.STATE_COOLDOWN, "LATE_PONG_BEFORE_REINSTALL");
      telemetry.emit("mentra_recovery_recovered", RecoveryConstants.STATE_HEALTHY, "LATE_PONG_BEFORE_REINSTALL", attempt, true);
      return Result.success();
    }

    if (waitForPong(context, WAIT_PING_INTERVAL_MS * 2)) {
      store.setState(RecoveryConstants.STATE_COOLDOWN, "LATE_PONG_BEFORE_REINSTALL");
      telemetry.emit(
          "mentra_recovery_recovered", RecoveryConstants.STATE_HEALTHY, "LATE_PONG_BEFORE_REINSTALL", attempt, true);
      return Result.success();
    }
    String stateBeforeReinstall = store.getState();
    if (RecoveryConstants.STATE_HEALTHY.equals(stateBeforeReinstall)
        || RecoveryConstants.STATE_COOLDOWN.equals(stateBeforeReinstall)) {
      Log.i(RecoveryConstants.TAG, "ASG healthy before reinstall; aborting reinstall");
      store.setState(RecoveryConstants.STATE_COOLDOWN, "HEALTHY_BEFORE_REINSTALL");
      telemetry.emit(
          "mentra_recovery_recovered", RecoveryConstants.STATE_HEALTHY, "HEALTHY_BEFORE_REINSTALL", attempt, true);
      return Result.success();
    }

    // We have now exhausted restart plus late-PONG checks. Only at this proven recovery
    // boundary may the independent worker tear down an AP explicitly marked as belonging to
    // the ASG replacement. It never starts or otherwise owns the hotspot.
    new HotspotOtaFailsafe(context).stopOrphanedVendorApIfOwned();
    store.setState(RecoveryConstants.STATE_REINSTALLING_BACKUP, "RESTART_FAILED");
    telemetry.emit(
        "mentra_recovery_reinstall_attempted",
        RecoveryConstants.STATE_REINSTALLING_BACKUP,
        "RESTART_FAILED",
        attempt,
        false);
    // Install boundary: the check, the reinstall it authorizes, and the OBSERVED completion of
    // that reinstall must be one lock-held unit. The OEM install is an asynchronous broadcast:
    // releasing at dispatch would let a downgrade begin while the higher backup install is still
    // in flight, and that install could then commit over the pinned target. So after dispatch we
    // keep the lock until the installed versionCode reaches the backup's (bounded wait). A
    // downgrade beginning after that simply supersedes the reinstalled build; one beginning
    // during the wait blocks in DowngradeWorker on this same lock. If the observe window times
    // out with the install still unobserved, the downgrade path is not stuck forever: its own
    // WAIT_FOR_REVERT loop re-dispatches the uninstall whenever a higher build (re)appears, so
    // even a straggler install that commits later is driven back off the device.
    boolean reinstallDispatched;
    DowngradeTransactionStore.installLock().lock();
    try {
      if (new DowngradeTransactionStore(context).isActive()) {
        Log.i(
            RecoveryConstants.TAG, "Downgrade transaction began during recovery; aborting reinstall");
        store.setState(RecoveryConstants.STATE_COOLDOWN, "DOWNGRADE_ACTIVE_SKIP_REINSTALL");
        return Result.success();
      }

      notifyInstallInProgress(context);
      // Capture the package generation BEFORE dispatching: the backup normally archives the
      // currently installed build, so after a same-version replace the versionCode alone is
      // indistinguishable from the pre-existing install — the first poll would "observe"
      // completion at dispatch time. lastUpdateTime advances only when the replacement
      // actually commits, so requiring a newer generation observes the operation itself.
      long preDispatchGeneration = installedAsgLastUpdateTime(context);
      reinstallDispatched = new ReinstallStrategy(context).execute();
      if (reinstallDispatched) {
        long backupVersion = new BackupStore(context).getBackupVersionCode();
        if (backupVersion > 0
            && !waitForAsgReplacementCommit(
                context,
                backupVersion,
                preDispatchGeneration,
                RecoveryConstants.REINSTALL_OBSERVE_TIMEOUT_MS)) {
          Log.w(
              RecoveryConstants.TAG,
              "Backup install commit not observed within "
                  + RecoveryConstants.REINSTALL_OBSERVE_TIMEOUT_MS
                  + "ms; releasing install lock (downgrade WAIT_FOR_REVERT + convergence linger"
                  + " self-heal stragglers)");
        }
      }
    } finally {
      DowngradeTransactionStore.installLock().unlock();
    }

    if (!reinstallDispatched) {
      notifyInstallCompleted(context);
      if (waitForPong(context, RecoveryConstants.RESTART_GRACE_MS)) {
        store.setState(RecoveryConstants.STATE_COOLDOWN, "ASG_ALIVE_SKIP_REINSTALL");
        telemetry.emit(
            "mentra_recovery_recovered",
            RecoveryConstants.STATE_HEALTHY,
            "ASG_ALIVE_SKIP_REINSTALL",
            attempt,
            true);
        return Result.success();
      }
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

    notifyInstallCompleted(context);
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
    notifyInstallCompleted(context);
    store.setState(RecoveryConstants.STATE_COOLDOWN, reason);
    telemetry.emit("mentra_recovery_recovered", RecoveryConstants.STATE_HEALTHY, reason, attempt, true);
    return Result.success();
  }

  /** {@code lastUpdateTime} of the installed ASG package, or {@code 0} when unresolvable. */
  private static long installedAsgLastUpdateTime(Context context) {
    try {
      return context
          .getPackageManager()
          .getPackageInfo(RecoveryConstants.ASG_PACKAGE, 0)
          .lastUpdateTime;
    } catch (Exception e) {
      return 0L;
    }
  }

  /**
   * Bounded poll for the dispatched replacement to COMMIT: the installed package must carry the
   * backup's versionCode AND a {@code lastUpdateTime} newer than the pre-dispatch generation.
   * Version equality alone is satisfied by the pre-existing install in the common
   * backup-equals-installed case.
   */
  private boolean waitForAsgReplacementCommit(
      Context context, long expectedVersion, long preDispatchGeneration, long timeoutMs) {
    long deadline = SystemClock.elapsedRealtime() + timeoutMs;
    while (SystemClock.elapsedRealtime() < deadline) {
      try {
        android.content.pm.PackageInfo info =
            context.getPackageManager().getPackageInfo(RecoveryConstants.ASG_PACKAGE, 0);
        long installed =
            android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : info.versionCode;
        if (installed == expectedVersion && info.lastUpdateTime > preDispatchGeneration) {
          return true;
        }
      } catch (Exception ignored) {
        // Package briefly unresolvable mid-install; keep polling.
      }
      SystemClock.sleep(1000L);
    }
    return false;
  }

  private boolean waitForPong(Context context, long timeoutMs) {
    final Object lock = new Object();
    final boolean[] gotAck = {false};
    final Handler pingHandler = new Handler(Looper.getMainLooper());
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
    Runnable pingRunnable =
        new Runnable() {
          @Override
          public void run() {
            synchronized (lock) {
              if (gotAck[0]) {
                return;
              }
            }
            sendPingToAsg(context);
            pingHandler.postDelayed(this, WAIT_PING_INTERVAL_MS);
          }
        };
    try {
      ContextCompat.registerReceiver(
          context,
          pongReceiver,
          new IntentFilter(RecoveryConstants.ACTION_PONG),
          RecoveryConstants.RECOVERY_HEARTBEAT_PERMISSION,
          null,
          ContextCompat.RECEIVER_EXPORTED);
      sendPingToAsg(context);
      pingHandler.postDelayed(pingRunnable, WAIT_PING_INTERVAL_MS);
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
      pingHandler.removeCallbacks(pingRunnable);
      try {
        context.unregisterReceiver(pongReceiver);
      } catch (Exception ignored) {
      }
    }
    return gotAck[0];
  }

  private void notifyInstallInProgress(Context context) {
    InstallPauseNotifier.notifyInstallInProgress();
  }

  private void notifyInstallCompleted(Context context) {
    InstallPauseNotifier.notifyInstallCompleted();
  }

  private void sendPingToAsg(Context context) {
    Intent ping = new Intent(RecoveryConstants.ACTION_PING);
    ping.setPackage(RecoveryConstants.ASG_PACKAGE);
    ping.addFlags(Intent.FLAG_INCLUDE_STOPPED_PACKAGES);
    context.sendBroadcast(ping, RecoveryConstants.RECOVERY_HEARTBEAT_PERMISSION);
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
