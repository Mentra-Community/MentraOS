package com.mentra.recovery.remediation;

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
import com.mentra.recovery.health.InstallPauseNotifier;
import com.mentra.recovery.telemetry.RecoveryTelemetry;
import com.mentra.recovery.util.RecoveryConstants;

/**
 * Self-contained remediation path: fetches the OTA manifest, and if the installed ASG build is
 * stuck at or below a target ceiling, downloads and force-installs a newer ASG APK directly.
 *
 * <p>This runs independently of ASG's own OTA flow (and the phone), so it recovers devices whose
 * ASG OTA cache/update path is broken. The download is always fresh, so the ASG cache is bypassed
 * implicitly.
 */
public class RemediationWorker extends Worker {
  private static final long WAIT_PING_INTERVAL_MS = 3000L;

  /**
   * Cross-run mutual exclusion. The boot prompt and the periodic job use different unique work
   * names, so WorkManager may run two instances at once. They share a single download/install path
   * and APK file, so only one may run the critical section at a time.
   */
  private static final java.util.concurrent.atomic.AtomicBoolean RUNNING =
      new java.util.concurrent.atomic.AtomicBoolean(false);

  public RemediationWorker(@NonNull Context context, @NonNull WorkerParameters params) {
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
    int attempt = getRunAttemptCount();

    // Defer to any in-flight ASG-driven install to avoid racing installs.
    if (InstallPauseNotifier.isInstallPaused()) {
      Log.i(RecoveryConstants.TAG, "Install in progress; deferring remediation check");
      return Result.retry();
    }

    // Serialize boot and periodic runs before any fetch/download so they cannot clobber the shared
    // remediation APK or dispatch duplicate installs.
    if (!RUNNING.compareAndSet(false, true)) {
      Log.i(RecoveryConstants.TAG, "Another remediation run in progress; deferring");
      return Result.retry();
    }
    try {
      return runRemediation(context, attempt);
    } finally {
      RUNNING.set(false);
    }
  }

  private Result runRemediation(Context context, int attempt) {
    RemediationManifestClient client = new RemediationManifestClient();
    RemediationPolicy policy = client.fetchPolicy();
    if (policy == null) {
      Log.d(RecoveryConstants.TAG, "No remediation policy in manifest; nothing to do");
      return Result.success();
    }
    if (!policy.enabled) {
      Log.d(RecoveryConstants.TAG, "Remediation disabled; nothing to do");
      return Result.success();
    }

    long installedVersion = RemediationEvaluator.getInstalledVersion(context, policy.packageName);
    if (!RemediationEvaluator.isEligible(policy, installedVersion)) {
      Log.i(
          RecoveryConstants.TAG,
          "Device not eligible for remediation (installed="
              + installedVersion
              + ", "
              + policy
              + ")");
      return Result.success();
    }
    if (RemediationEvaluator.alreadyApplied(context, policy)) {
      Log.i(RecoveryConstants.TAG, "Remediation ASG " + policy.asgVersion + " already applied; skipping");
      return Result.success();
    }

    RecoveryTelemetry telemetry = new RecoveryTelemetry(context);

    RemediationDownloader downloader = new RemediationDownloader();
    if (!downloader.download(policy)) {
      Log.e(RecoveryConstants.TAG, "Remediation download/verify failed; will retry");
      telemetry.emit(
          "mentra_remediation_failed", policy.versionName, "DOWNLOAD_OR_VERIFY_FAILED", attempt, false);
      return Result.retry();
    }

    RemediationInstaller installer = new RemediationInstaller(context);
    if (!installer.install(policy)) {
      telemetry.emit(
          "mentra_remediation_failed", policy.versionName, "INSTALL_DISPATCH_FAILED", attempt, false);
      return Result.retry();
    }

    try {
      boolean alive = waitForPong(context, RecoveryConstants.RESTART_GRACE_MS);

      // Re-read the installed version to confirm the OEM install actually took effect before
      // marking applied. A PONG can arrive from the OLD build while it is still alive (the OEM
      // installer kills ASG asynchronously), so trusting a PONG alone can suppress future
      // remediation even when the install was rejected or dropped.
      long nowInstalled =
          RemediationEvaluator.getInstalledVersion(context, policy.packageName);
      boolean installConfirmed = nowInstalled == policy.asgVersion;

      if (alive) {
        if (installConfirmed) {
          // PONG + version confirmed — definitive success.
          RemediationEvaluator.markApplied(context, policy);
          telemetry.emit(
              "mentra_remediation_applied", policy.versionName, "PONG_AFTER_INSTALL", attempt, true);
          return Result.success();
        }
        // PONG from old build before installer fired, or installer was rejected/dropped.
        // Do NOT mark applied so the next periodic run can retry.
        Log.w(RecoveryConstants.TAG,
            "PONG received but installed version " + nowInstalled
                + " != target " + policy.asgVersion + "; not marking applied, will retry");
        telemetry.emit(
            "mentra_remediation_failed",
            policy.versionName,
            "PONG_VERSION_NOT_UPDATED",
            attempt,
            false);
        return Result.retry();
      }

      // No PONG: ASG was likely killed by the OEM installer and is rebooting. Mark applied to
      // avoid dispatching a duplicate install on the next run. Emit success/failure based on
      // whether the version is already confirmed (fast install) or still pending (mid-reboot).
      RemediationEvaluator.markApplied(context, policy);
      if (installConfirmed) {
        telemetry.emit(
            "mentra_remediation_applied",
            policy.versionName,
            "NO_PONG_VERSION_CONFIRMED",
            attempt,
            true);
      } else {
        telemetry.emit(
            "mentra_remediation_failed",
            policy.versionName,
            "NO_PONG_AFTER_INSTALL",
            attempt,
            false);
      }
      return Result.success();
    } finally {
      InstallPauseNotifier.notifyInstallCompleted();
    }
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
