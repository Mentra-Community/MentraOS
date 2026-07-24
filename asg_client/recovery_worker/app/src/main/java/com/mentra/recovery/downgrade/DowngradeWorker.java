package com.mentra.recovery.downgrade;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.mentra.recovery.health.InstallPauseNotifier;
import com.mentra.recovery.telemetry.RecoveryTelemetry;
import com.mentra.recovery.util.RecoveryConstants;
import com.mentra.recovery.util.SystemInstaller;

import java.io.File;
import java.io.FileInputStream;
import java.security.MessageDigest;
import java.util.Set;
import java.util.TreeSet;

/**
 * Drives one persisted pinned-downgrade transaction to convergence.
 *
 * <p>The OEM installer refuses lower-versionCode installs, so a downgrade takes the detour:
 * uninstall the ASG system-app update (reverts to the passive factory {@code /system} build and
 * wipes ASG {@code /data/data} — the deterministic state reset a downgrade requires), then install
 * the staged target APK, which is an ordinary upgrade from the factory floor. Every step is derived
 * from observable package state, so the worker is safe to re-run after process death, reboot, or a
 * lost broadcast at any point.
 *
 * <p>If the transaction gives up after the revert, the device is left on the factory build with the
 * transaction cleared. There is deliberately no autonomous path back to a fleet build: the factory
 * build is a functioning, pairable baseline, and on the next phone connection the version check
 * sees factory != pin and re-offers the target through the normal phone-driven flow — which from
 * the factory floor is a plain OEM upgrade install, a simpler and independently exercised
 * mechanism than the recovery-side install that just failed. Heartbeat recovery does not fight
 * this state either: a responsive factory ASG is healthy, so the fleet backup is not reinstalled
 * over it.
 */
public class DowngradeWorker extends Worker {

  public DowngradeWorker(@NonNull Context context, @NonNull WorkerParameters params) {
    super(context, params);
  }

  @NonNull
  @Override
  public Result doWork() {
    Context context = getApplicationContext();
    DowngradeTransactionStore store = new DowngradeTransactionStore(context);
    if (!store.isActive()) {
      return Result.success();
    }

    RecoveryTelemetry telemetry = new RecoveryTelemetry(context);
    long target = store.getTargetVersion();
    int attempt = getRunAttemptCount();

    if (System.currentTimeMillis() - store.getStartedAtMs()
        > RecoveryConstants.DOWNGRADE_TRANSACTION_STALE_MS) {
      return giveUp(store, telemetry, target, "TRANSACTION_STALE", attempt);
    }

    // Pause heartbeat monitoring for the whole detour so the uninstall/install windows are not
    // mistaken for an ASG crash and remediated mid-transaction.
    InstallPauseNotifier.notifyInstallInProgress();
    try {
      SystemInstaller installer = new SystemInstaller(context);
      while (true) {
        long installed = installedAsgVersion(context);
        DowngradePlan.Action action =
            DowngradePlan.nextAction(
                installed,
                target,
                store.isUninstallRequested(),
                store.getInstallAttempts(),
                RecoveryConstants.DOWNGRADE_MAX_INSTALL_ATTEMPTS);
        Log.i(
            RecoveryConstants.TAG,
            "Downgrade step: installed=" + installed + ", target=" + target + " -> " + action);

        switch (action) {
          case ALREADY_AT_TARGET:
            deleteStagedApk(store);
            store.clear();
            telemetry.emit(
                "mentra_downgrade_applied", String.valueOf(target), "VERSION_CONVERGED", attempt, true);
            return Result.success();

          case SEND_UNINSTALL:
            // Validate the staged APK BEFORE the first mutation: if it is unusable, abort with
            // the current build still installed and untouched.
            if (!isStagedApkValid(context, store)) {
              return giveUp(store, telemetry, target, "STAGED_APK_INVALID", attempt);
            }
            store.markUninstallRequested();
            // fall through to dispatch + wait
          case WAIT_FOR_REVERT:
            // Re-dispatching the uninstall is harmless while still above target and self-heals a
            // broadcast lost to process death between persist and dispatch.
            installer.uninstallPackage(RecoveryConstants.ASG_PACKAGE);
            // Wait for a REAL lower installed build (the factory floor), not just "below target":
            // mid-uninstall the package is briefly unresolved (installedAsgVersion == -1), which
            // is below target but is NOT the factory build being present. Dispatching SEND_INSTALL
            // then would race the still-in-flight OEM uninstall.
            if (!waitForInstalledVersion(
                context,
                v -> v > 0 && v < target,
                RecoveryConstants.DOWNGRADE_REVERT_TIMEOUT_MS)) {
              Log.w(RecoveryConstants.TAG, "Factory revert not observed in time; will retry");
              return Result.retry();
            }
            break;

          case SEND_INSTALL:
            // Re-validate against the archive only: after the revert the wipe is already done, so
            // an unusable APK here means giving up to the factory build (the phone re-offers
            // the pin as a plain upgrade on its next check).
            if (!isStagedApkValid(context, store)) {
              return giveUp(store, telemetry, target, "STAGED_APK_INVALID_POST_REVERT", attempt);
            }
            store.incrementInstallAttempts();
            installer.installApk(store.getApkPath(), RecoveryConstants.ASG_PACKAGE);
            if (!waitForInstalledVersion(
                context, v -> v == target, RecoveryConstants.DOWNGRADE_INSTALL_TIMEOUT_MS)) {
              Log.w(
                  RecoveryConstants.TAG,
                  "Target version not observed after install dispatch "
                      + store.getInstallAttempts()
                      + "; re-evaluating");
            }
            break;

          case GIVE_UP:
          default:
            return giveUp(store, telemetry, target, "INSTALL_ATTEMPTS_EXHAUSTED", attempt);
        }
      }
    } finally {
      InstallPauseNotifier.notifyInstallCompleted();
    }
  }

  private Result giveUp(
      DowngradeTransactionStore store,
      RecoveryTelemetry telemetry,
      long target,
      String reason,
      int attempt) {
    Log.e(RecoveryConstants.TAG, "Downgrade transaction giving up: " + reason);
    deleteStagedApk(store);
    store.clear();
    telemetry.emit("mentra_downgrade_failed", String.valueOf(target), reason, attempt, false);
    return Result.failure();
  }

  private interface VersionPredicate {
    boolean test(long installedVersion);
  }

  private boolean waitForInstalledVersion(
      Context context, VersionPredicate predicate, long timeoutMs) {
    long deadline = SystemClock.elapsedRealtime() + timeoutMs;
    while (SystemClock.elapsedRealtime() < deadline) {
      if (predicate.test(installedAsgVersion(context))) {
        return true;
      }
      try {
        Thread.sleep(RecoveryConstants.DOWNGRADE_POLL_INTERVAL_MS);
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return false;
      }
    }
    return predicate.test(installedAsgVersion(context));
  }

  /** Installed ASG versionCode, or -1 when the package cannot be resolved. */
  private static long installedAsgVersion(Context context) {
    try {
      PackageInfo info =
          context.getPackageManager().getPackageInfo(RecoveryConstants.ASG_PACKAGE, 0);
      return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
          ? info.getLongVersionCode()
          : info.versionCode;
    } catch (PackageManager.NameNotFoundException e) {
      return -1L;
    }
  }

  /**
   * Full validation of the staged APK: readable, checksum-matched, correct package, matching
   * versionCode, not testOnly, and signed by the same signers as the installed build when one is
   * present (the factory build shares the release signers, so this holds across the revert).
   */
  private boolean isStagedApkValid(Context context, DowngradeTransactionStore store) {
    File apk = new File(store.getApkPath());
    if (!apk.exists() || !apk.canRead() || apk.length() <= 0) {
      Log.e(RecoveryConstants.TAG, "Staged downgrade APK missing/unreadable: " + store.getApkPath());
      return false;
    }
    String expectedSha = store.getApkSha256();
    if (expectedSha != null && !expectedSha.isEmpty()) {
      String actual = sha256Of(apk);
      if (!expectedSha.equalsIgnoreCase(actual)) {
        Log.e(RecoveryConstants.TAG, "Staged downgrade APK sha256 mismatch");
        return false;
      }
    }
    try {
      PackageManager pm = context.getPackageManager();
      PackageInfo archive =
          pm.getPackageArchiveInfo(
              apk.getAbsolutePath(),
              PackageManager.GET_ACTIVITIES | PackageManager.GET_SIGNING_CERTIFICATES);
      if (archive == null || !RecoveryConstants.ASG_PACKAGE.equals(archive.packageName)) {
        Log.e(RecoveryConstants.TAG, "Staged downgrade APK is not the ASG package");
        return false;
      }
      long archiveVersion =
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
              ? archive.getLongVersionCode()
              : archive.versionCode;
      if (archiveVersion != store.getTargetVersion()) {
        Log.e(
            RecoveryConstants.TAG,
            "Staged downgrade APK version "
                + archiveVersion
                + " does not match target "
                + store.getTargetVersion());
        return false;
      }
      ApplicationInfo appInfo = archive.applicationInfo;
      if (appInfo == null) {
        return false;
      }
      appInfo.sourceDir = apk.getAbsolutePath();
      appInfo.publicSourceDir = apk.getAbsolutePath();
      if ((appInfo.flags & ApplicationInfo.FLAG_TEST_ONLY) != 0) {
        Log.e(RecoveryConstants.TAG, "Staged downgrade APK is testOnly; OEM installer will reject it");
        return false;
      }
      Set<String> archiveSigners = signerDigests(archive);
      if (archiveSigners.isEmpty()) {
        return false;
      }
      try {
        PackageInfo installedInfo =
            pm.getPackageInfo(
                RecoveryConstants.ASG_PACKAGE, PackageManager.GET_SIGNING_CERTIFICATES);
        Set<String> installedSigners = signerDigests(installedInfo);
        if (!installedSigners.isEmpty() && !archiveSigners.equals(installedSigners)) {
          Log.e(RecoveryConstants.TAG, "Staged downgrade APK signer mismatch with installed build");
          return false;
        }
      } catch (PackageManager.NameNotFoundException e) {
        Log.w(RecoveryConstants.TAG, "ASG not installed; validating archive signature only");
      }
      return true;
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to validate staged downgrade APK", e);
      return false;
    }
  }

  private void deleteStagedApk(DowngradeTransactionStore store) {
    String path = store.getApkPath();
    if (path == null || path.isEmpty()) {
      return;
    }
    File apk = new File(path);
    if (apk.exists() && !apk.delete()) {
      Log.w(RecoveryConstants.TAG, "Failed to delete staged downgrade APK: " + path);
    }
  }

  private static String sha256Of(File file) {
    try (FileInputStream in = new FileInputStream(file)) {
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      byte[] buffer = new byte[8192];
      int read;
      while ((read = in.read(buffer)) != -1) {
        digest.update(buffer, 0, read);
      }
      StringBuilder sb = new StringBuilder();
      for (byte b : digest.digest()) {
        sb.append(String.format("%02x", b));
      }
      return sb.toString();
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to hash staged downgrade APK", e);
      return "";
    }
  }

  private static Set<String> signerDigests(PackageInfo info) {
    Set<String> digests = new TreeSet<>();
    try {
      Signature[] signers = null;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
        signers = info.signingInfo.getApkContentsSigners();
      } else if (info.signatures != null) {
        signers = info.signatures;
      }
      if (signers == null) {
        return digests;
      }
      MessageDigest digest = MessageDigest.getInstance("SHA-256");
      for (Signature signature : signers) {
        if (signature == null) {
          continue;
        }
        byte[] hash = digest.digest(signature.toByteArray());
        StringBuilder sb = new StringBuilder(hash.length * 2);
        for (byte b : hash) {
          sb.append(String.format("%02x", b));
        }
        digests.add(sb.toString());
      }
    } catch (Exception e) {
      Log.e(RecoveryConstants.TAG, "Failed to hash signer", e);
    }
    return digests;
  }
}
